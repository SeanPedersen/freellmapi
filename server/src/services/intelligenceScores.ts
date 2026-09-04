/** Fetches and persists verified Artificial Analysis intelligence scores via ModelGrep. */
import { getDb } from '../db/index.js';

const MODEL_GREP_URL = 'https://modelgrep.com/api/v1/models?benchmarked=1&limit=200';
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const SYNC_SETTING_KEY = 'modelgrep_scores_last_synced_at';

type ModelGrepEntry = { id?: unknown; benchmarks?: { artificial_analysis?: { intelligence?: unknown } } };
type ModelGrepPage = {
  data?: ModelGrepEntry[];
  meta?: { has_more?: unknown; next_offset?: unknown };
};

const EXPLICIT_ALIASES: Record<string, string> = {
  'cerebras:gpt-oss-120b': 'openai/gpt-oss-120b',
  'cerebras:gpt-oss-20b': 'openai/gpt-oss-20b',
};

const PROVIDER_PREFIXES: Record<string, string> = {
  inceptionlabs: 'inception',
  zhipu: 'zai',
};

const RELEASE_DATE_SUFFIX = /-\d{2}-\d{4}$/;

let intervalId: ReturnType<typeof setInterval> | null = null;

function scoreFromModel(model: ModelGrepEntry): [string, number] | null {
  const id = model.id;
  const score = model.benchmarks?.artificial_analysis?.intelligence;
  if (typeof id !== 'string' || typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) return null;
  return [id, score];
}

export function resolveCanonicalModelId(platform: string, modelId: string, canonicalIds: ReadonlySet<string>): string | null {
  if (canonicalIds.has(modelId)) return modelId;
  const alias = EXPLICIT_ALIASES[`${platform}:${modelId}`];
  if (alias && canonicalIds.has(alias)) return alias;

  // Cerebras uses a hyphen after the Qwen family name while ModelGrep uses
  // Qwen's official compact version spelling (for example qwen3.8-27b).
  const qwenMatch = platform === 'cerebras' && /^qwen-(\d+(?:\.\d+)+-.+)$/.exec(modelId);
  if (qwenMatch) {
    const qwenId = `qwen/qwen${qwenMatch[1]}`;
    if (canonicalIds.has(qwenId)) return qwenId;
  }

  const normalizedId = platform === 'cloudflare' && modelId.startsWith('@cf/')
    ? modelId.slice('@cf/'.length)
    : modelId;
  if (canonicalIds.has(normalizedId)) return normalizedId;
  const providerPrefix = PROVIDER_PREFIXES[platform] ?? platform;
  const candidate = `${providerPrefix}/${normalizedId}`;
  if (canonicalIds.has(candidate)) return candidate;

  const releaseName = normalizedId.replace(RELEASE_DATE_SUFFIX, '');
  const releaseCandidate = `${providerPrefix}/${releaseName}`;
  return releaseName !== normalizedId && canonicalIds.has(releaseCandidate) ? releaseCandidate : null;
}

function cachedScores(): Map<string, number> {
  const rows = getDb().prepare('SELECT model_id, intelligence_score FROM modelgrep_scores').all() as Array<{ model_id: string; intelligence_score: number }>;
  return new Map(rows.map(row => [row.model_id, row.intelligence_score]));
}

export function getCachedIntelligenceScore(platform: string, modelId: string): number | null {
  const scores = cachedScores();
  const canonicalId = resolveCanonicalModelId(platform, modelId, new Set(scores.keys()));
  return canonicalId ? scores.get(canonicalId) ?? null : null;
}

export function applyCachedIntelligenceScores(): void {
  const db = getDb();
  const scores = cachedScores();
  const ids = new Set(scores.keys());
  const models = db.prepare('SELECT id, platform, model_id FROM models').all() as Array<{ id: number; platform: string; model_id: string }>;
  const update = db.prepare('UPDATE models SET intelligence_score = ? WHERE id = ?');
  db.transaction(() => {
    for (const model of models) {
      const canonicalId = resolveCanonicalModelId(model.platform, model.model_id, ids);
      update.run(canonicalId ? scores.get(canonicalId) ?? null : null, model.id);
    }
  })();
}

async function fetchPage(url: string): Promise<ModelGrepPage> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`ModelGrep returned ${response.status}`);
  return response.json() as Promise<ModelGrepPage>;
}

export async function fetchModelGrepScores(): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  let url = MODEL_GREP_URL;
  for (;;) {
    const page = await fetchPage(url);
    if (!Array.isArray(page.data) || page.data.length === 0) throw new Error('ModelGrep returned an invalid or empty page');
    for (const model of page.data) {
      const aaScore = model.benchmarks?.artificial_analysis?.intelligence;
      // ModelGrep's benchmarked catalog also includes models with non-AA benchmarks.
      // They are deliberately unscored for this feature, not a malformed AA result.
      if (aaScore === undefined || aaScore === null) continue;
      const parsed = scoreFromModel(model);
      if (!parsed) throw new Error('ModelGrep returned an invalid AA intelligence score');
      scores.set(...parsed);
    }
    if (page.meta?.has_more !== true) break;
    if (typeof page.meta.next_offset !== 'number' || !Number.isInteger(page.meta.next_offset) || page.meta.next_offset < 0) {
      throw new Error('ModelGrep returned an invalid pagination offset');
    }
    url = `${MODEL_GREP_URL}&offset=${page.meta.next_offset}`;
  }
  if (scores.size === 0) throw new Error('ModelGrep returned no AA intelligence scores');
  return scores;
}

export async function syncIntelligenceScores(force = false): Promise<boolean> {
  const lastSync = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(SYNC_SETTING_KEY) as { value: string } | undefined;
  if (!force && lastSync && Date.now() - Date.parse(lastSync.value) < SYNC_INTERVAL_MS) {
    applyCachedIntelligenceScores();
    return false;
  }
  try {
    const scores = await fetchModelGrepScores();
    const db = getDb();
    const insert = db.prepare('INSERT INTO modelgrep_scores (model_id, intelligence_score) VALUES (?, ?)');
    db.transaction(() => {
      db.prepare('DELETE FROM modelgrep_scores').run();
      for (const [modelId, score] of scores) insert.run(modelId, score);
      db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(SYNC_SETTING_KEY, new Date().toISOString());
    })();
    applyCachedIntelligenceScores();
    console.log(`[Intelligence] Synced ${scores.size} AA scores from ModelGrep.`);
    return true;
  } catch (error) {
    console.warn('[Intelligence] ModelGrep sync failed; retaining verified cache:', error instanceof Error ? error.message : error);
    return false;
  }
}

export async function startIntelligenceScoreSync(): Promise<void> {
  await syncIntelligenceScores();
  if (!intervalId) intervalId = setInterval(() => void syncIntelligenceScores(), SYNC_INTERVAL_MS);
}

export function stopIntelligenceScoreSync(): void {
  if (!intervalId) return;
  clearInterval(intervalId);
  intervalId = null;
}
