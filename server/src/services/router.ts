import { getDb } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { canMakeRequest, canUseTokens, isOnCooldown } from './ratelimit.js';
import type { BaseProvider } from '../providers/base.js';
import type { Database } from 'better-sqlite3';

interface ChainRow {
  model_db_id: number;
  platform: string;
  model_id: string;
  display_name: string;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
}

interface KeyRow {
  id: number;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: number;
}

// ── Thompson Sampling routing ──────────────────────────────────────────────
// For each request, sample a success-rate from each model's Beta posterior.
// Better models win more often but not exclusively — exploration is automatic
// and proportional to uncertainty, without degenerating into a single winner.

const ANALYTICS_WINDOW_MS = 24 * 60 * 60 * 1000;
const ANALYTICS_CACHE_TTL_MS = 60 * 1000;

// Beta prior: Beta(PRIOR_SUCCESS, PRIOR_FAILURE) — equivalent to 4 prior
// observations at 50 % success. New models start neutral, not perfect or broken.
const PRIOR_SUCCESS = 2;
const PRIOR_FAILURE = 2;

// Weight of the normalized speed signal added on top of the sampled success rate.
const SPEED_WEIGHT = 0.3;

// Optimistic speed prior for models with no successful history yet.
const SPEED_PRIOR = 1.0;

// Models below this tok/s threshold get an active penalty, not just a low reward.
const MIN_USEFUL_TOK_S = 10;
// Penalty weight applied proportionally to how far below the threshold the model is.
const SLOW_SPEED_PENALTY_WEIGHT = 0.35;

// How much each rate-limit penalty point reduces the effective score.
// At max penalty (10) a perfect model drops ~0.5 — into the neutral range.
export const PENALTY_SCORE_WEIGHT = 0.05;

// ── TTFB scoring ─────────────────────────────────────────────────────────────
// Weight of the TTFB signal. At its best (+1.0 raw) this adds 0.25 to the score;
// at its worst (>2 s) it subtracts ~0.075, actively discouraging slow models.
const TTFB_WEIGHT = 0.25;

// Thresholds (ms) that define the four quality bands.
const TTFB_VERY_GOOD_MS = 500;
const TTFB_GOOD_MS      = 1000;
const TTFB_ACCEPTABLE_MS = 2000;

// Optimistic prior for models with no TTFB measurements yet — slightly below
// "good" so they get a fair chance to prove themselves via exploration.
const TTFB_PRIOR = 0.75;

// Returns a normalized score in [~-0.3, 1.0] for a given average TTFB.
//   < 500 ms  → 1.0  (very good)
//   500–1000  → 1.0 → 0.6  (good, linear)
//   1000–2000 → 0.6 → 0.0  (ok, linear)
//   > 2000 ms → -0.3  (bad — active penalty to route away)
function ttfbRawScore(avgTtfbMs: number): number {
  if (avgTtfbMs < TTFB_VERY_GOOD_MS) return 1.0;
  if (avgTtfbMs < TTFB_GOOD_MS) {
    return 1.0 - 0.4 * (avgTtfbMs - TTFB_VERY_GOOD_MS) / (TTFB_GOOD_MS - TTFB_VERY_GOOD_MS);
  }
  if (avgTtfbMs < TTFB_ACCEPTABLE_MS) {
    return 0.6 - 0.6 * (avgTtfbMs - TTFB_GOOD_MS) / (TTFB_ACCEPTABLE_MS - TTFB_GOOD_MS);
  }
  return -0.3;
}

// Returns the weighted TTFB contribution to the routing score.
// null → optimistic prior (exploration for new/unseen models).
function ttfbContribution(avgTtfbMs: number | null): number {
  const raw = avgTtfbMs !== null ? ttfbRawScore(avgTtfbMs) : TTFB_PRIOR;
  return TTFB_WEIGHT * raw;
}

// Returns the combined speed term (reward − slow penalty) for a model with data.
// Slow models (below MIN_USEFUL_TOK_S) score negatively relative to no-data baseline.
function speedContribution(tokPerSec: number, maxTokPerSec: number): number {
  if (maxTokPerSec <= 0 || tokPerSec <= 0) return 0;
  const reward = SPEED_WEIGHT * (tokPerSec / maxTokPerSec);
  const penalty = tokPerSec < MIN_USEFUL_TOK_S
    ? SLOW_SPEED_PENALTY_WEIGHT * (1 - tokPerSec / MIN_USEFUL_TOK_S)
    : 0;
  return reward - penalty;
}

// ── Beta distribution sampler (Marsaglia & Tsang via two Gamma draws) ─────

function randomNormal(): number {
  const u1 = Math.random() || Number.EPSILON;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random());
}

function sampleGamma(shape: number): number {
  if (shape < 1) return sampleGamma(shape + 1) * Math.pow(Math.random() || Number.EPSILON, 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do { x = randomNormal(); v = 1 + c * x; } while (v <= 0);
    v = v ** 3;
    const u = Math.random();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function sampleBeta(alpha: number, beta: number): number {
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  return x / (x + y);
}

interface ModelStats {
  successes: number;
  total: number;
  tokPerSec: number;    // output tok/s from successful requests only
  avgTtfbMs: number | null; // avg TTFB across successful requests (null if no data)
}

let statsCache: Map<string, ModelStats> | null = null;
let statsCacheTime = 0;
let maxTokPerSec = 0;

export function refreshStatsCache(db: Database, force = false): void {
  if (!force && statsCache && Date.now() - statsCacheTime < ANALYTICS_CACHE_TTL_MS) return;

  const since = new Date(Date.now() - ANALYTICS_WINDOW_MS).toISOString();
  const rows = db.prepare(`
    SELECT platform, model_id,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successes,
      CASE
        WHEN SUM(CASE WHEN status = 'success' THEN latency_ms ELSE 0 END) > 0
        THEN SUM(CASE WHEN status = 'success' THEN output_tokens ELSE 0 END) * 1000.0
             / SUM(CASE WHEN status = 'success' THEN latency_ms ELSE 0 END)
        ELSE 0
      END as tok_per_sec,
      AVG(CASE WHEN status = 'success' AND ttfb_ms IS NOT NULL THEN ttfb_ms END) as avg_ttfb_ms
    FROM requests
    WHERE created_at >= ?
    GROUP BY platform, model_id
  `).all(since) as Array<{
    platform: string; model_id: string; total: number; successes: number;
    tok_per_sec: number; avg_ttfb_ms: number | null;
  }>;

  statsCache = new Map();
  maxTokPerSec = 0;
  for (const row of rows) {
    statsCache.set(`${row.platform}:${row.model_id}`, {
      successes: row.successes,
      total: row.total,
      tokPerSec: row.tok_per_sec,
      avgTtfbMs: row.avg_ttfb_ms ?? null,
    });
    if (row.tok_per_sec > maxTokPerSec) maxTokPerSec = row.tok_per_sec;
  }
  statsCacheTime = Date.now();
}

// Deterministic expected score — used by the dashboard to rank models for display.
export function getAnalyticsScore(platform: string, modelId: string): number {
  const stats = statsCache?.get(`${platform}:${modelId}`);
  const total = stats?.total ?? 0;
  const successes = stats?.successes ?? 0;
  const bayesRate = (successes + PRIOR_SUCCESS) / (total + PRIOR_SUCCESS + PRIOR_FAILURE);
  // No data → no speed contribution; SPEED_PRIOR is for routing exploration only
  const speed = (stats && stats.tokPerSec > 0)
    ? speedContribution(stats.tokPerSec, maxTokPerSec)
    : 0;
  // No data → no TTFB contribution for display score (avoid misleading the dashboard)
  const ttfbScore = (stats && stats.avgTtfbMs !== null)
    ? ttfbContribution(stats.avgTtfbMs)
    : 0;
  return bayesRate + speed + ttfbScore;
}

// Stochastic score used for routing — samples from the Beta posterior so that
// models are chosen probabilistically rather than always picking the single best.
function thompsonSampleScore(platform: string, modelId: string): number {
  const stats = statsCache?.get(`${platform}:${modelId}`);
  const alpha = (stats?.successes ?? 0) + PRIOR_SUCCESS;
  const beta  = ((stats?.total ?? 0) - (stats?.successes ?? 0)) + PRIOR_FAILURE;
  // No data → optimistic prior for exploration; with data → apply slow-speed penalty
  const speed = (stats && stats.tokPerSec > 0)
    ? speedContribution(stats.tokPerSec, maxTokPerSec)
    : SPEED_WEIGHT * SPEED_PRIOR;
  // No data → TTFB_PRIOR (optimistic, encourages exploration of unseen models)
  const ttfbScore = ttfbContribution(stats?.avgTtfbMs ?? null);
  return sampleBeta(alpha, beta) + speed + ttfbScore;
}

/**
 * Returns current analytics scores for every (platform, model_id) pair seen in
 * the last 24 h. Used by the fallback dashboard to surface routing rationale.
 */
export function getAnalyticsScores(): Array<{
  platform: string;
  modelId: string;
  score: number;
  successRate: number;
  total: number;
  tokPerSec: number;
  avgTtfbMs: number | null;
}> {
  if (!statsCache) return [];
  const result: Array<{
    platform: string;
    modelId: string;
    score: number;
    successRate: number;
    total: number;
    tokPerSec: number;
    avgTtfbMs: number | null;
  }> = [];
  for (const [key, stats] of statsCache) {
    const [platform, ...rest] = key.split(':');
    const modelId = rest.join(':');
    result.push({
      platform,
      modelId,
      score: getAnalyticsScore(platform, modelId),
      successRate: stats.total > 0 ? stats.successes / stats.total : 0,
      total: stats.total,
      tokPerSec: stats.tokPerSec,
      avgTtfbMs: stats.avgTtfbMs,
    });
  }
  return result.sort((a, b) => b.score - a.score);
}

export interface RouteResult {
  provider: BaseProvider;
  modelId: string;
  modelDbId: number;
  apiKey: string;
  keyId: number;
  platform: string;
  displayName: string;
}

// Round-robin index per platform
const roundRobinIndex = new Map<string, number>();

// ── Dynamic priority: track 429s per model and demote accordingly ──
// Key: model_db_id → { count, lastHit, penalty }
const rateLimitPenalties = new Map<number, { count: number; lastHit: number; penalty: number }>();

// Penalty decays over time so models recover
const PENALTY_PER_429 = 3;        // each 429 adds this many priority positions
const MAX_PENALTY = 10;            // cap so a model doesn't sink forever
const DECAY_INTERVAL_MS = 2 * 60 * 1000; // penalty decays every 2 minutes
const DECAY_AMOUNT = 1;            // remove this much penalty per decay interval

/**
 * Record a 429 for a model — increases its penalty so it sinks in priority.
 */
export function recordRateLimitHit(modelDbId: number) {
  const existing = rateLimitPenalties.get(modelDbId);
  const now = Date.now();
  if (existing) {
    existing.count++;
    existing.lastHit = now;
    existing.penalty = Math.min(existing.penalty + PENALTY_PER_429, MAX_PENALTY);
  } else {
    rateLimitPenalties.set(modelDbId, { count: 1, lastHit: now, penalty: PENALTY_PER_429 });
  }
}

/**
 * Record a success for a model — reduces its penalty so it rises back up.
 */
export function recordSuccess(modelDbId: number) {
  const existing = rateLimitPenalties.get(modelDbId);
  if (existing) {
    existing.penalty = Math.max(0, existing.penalty - 1);
    if (existing.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
    }
  }
}

/**
 * Get the current penalty for a model (with time-based decay).
 */
function getPenalty(modelDbId: number): number {
  const entry = rateLimitPenalties.get(modelDbId);
  if (!entry) return 0;

  // Apply time-based decay
  const now = Date.now();
  const elapsed = now - entry.lastHit;
  const decaySteps = Math.floor(elapsed / DECAY_INTERVAL_MS);
  if (decaySteps > 0) {
    entry.penalty = Math.max(0, entry.penalty - (decaySteps * DECAY_AMOUNT));
    entry.lastHit = now; // reset so we don't double-decay
    if (entry.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
      return 0;
    }
  }

  return entry.penalty;
}

/**
 * Get current penalties for all models (for the API/dashboard).
 */
export function getAllPenalties(): Array<{ modelDbId: number; count: number; penalty: number }> {
  const result: Array<{ modelDbId: number; count: number; penalty: number }> = [];
  for (const [modelDbId, entry] of rateLimitPenalties) {
    const penalty = getPenalty(modelDbId);
    if (penalty > 0) {
      result.push({ modelDbId, count: entry.count, penalty });
    }
  }
  return result.sort((a, b) => b.penalty - a.penalty);
}

/**
 * Route a request to the best available model.
 *
 * Ordering is pure bandit: higher score = tried first.
 *   score = bayesSuccessRate + ucbExplorationBonus + SPEED_WEIGHT * normalizedTokPerSec
 *   effectiveScore = score − penalty × PENALTY_SCORE_WEIGHT
 *
 * If preferredModelDbId is set, that model is forced to the front (sticky sessions)
 * to prevent hallucination from model switching mid-conversation.
 *
 * @param estimatedTokens - estimated total tokens for rate-limit pre-check
 * @param skipKeys - "platform:modelId:keyId" triples to skip (already failed this request)
 * @param preferredModelDbId - pin this model to position 0 (sticky session)
 */
export function routeRequest(estimatedTokens = 1000, skipKeys?: Set<string>, preferredModelDbId?: number): RouteResult {
  const db = getDb();

  // Refresh analytics cache (no-op if called within the TTL window)
  refreshStatsCache(db);

  const chain = db.prepare(`
    SELECT fc.model_db_id,
           m.platform, m.model_id, m.display_name,
           m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id AND m.enabled = 1
    WHERE fc.enabled = 1
  `).all() as ChainRow[];

  const sorted = chain.map(entry => ({
    ...entry,
    effectiveScore:
      thompsonSampleScore(entry.platform, entry.model_id)
      - getPenalty(entry.model_db_id) * PENALTY_SCORE_WEIGHT,
  })).sort((a, b) => b.effectiveScore - a.effectiveScore);

  // Sticky session: force preferred model to the front regardless of score
  if (preferredModelDbId) {
    const idx = sorted.findIndex(e => e.model_db_id === preferredModelDbId);
    if (idx > 0) {
      const [preferred] = sorted.splice(idx, 1);
      sorted.unshift(preferred);
    }
  }

  for (const entry of sorted) {
    const provider = getProvider(entry.platform as any);
    if (!provider) continue;

    const keys = db.prepare(
      'SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status != ?'
    ).all(entry.platform, 'invalid') as KeyRow[];

    if (keys.length === 0) continue;

    const limits = {
      rpm: entry.rpm_limit,
      rpd: entry.rpd_limit,
      tpm: entry.tpm_limit,
      tpd: entry.tpd_limit,
    };

    const rrKey = `${entry.platform}:${entry.model_id}`;
    let idx = roundRobinIndex.get(rrKey) ?? 0;

    for (let attempt = 0; attempt < keys.length; attempt++) {
      const key = keys[idx % keys.length];
      idx++;

      const skipId = `${entry.platform}:${entry.model_id}:${key.id}`;
      if (skipKeys?.has(skipId)) continue;
      if (isOnCooldown(entry.platform, entry.model_id, key.id)) continue;
      if (!canMakeRequest(entry.platform, entry.model_id, key.id, limits)) continue;
      if (!canUseTokens(entry.platform, entry.model_id, key.id, estimatedTokens, limits)) continue;

      roundRobinIndex.set(rrKey, idx);
      const decryptedKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);

      return {
        provider,
        modelId: entry.model_id,
        modelDbId: entry.model_db_id,
        apiKey: decryptedKey,
        keyId: key.id,
        platform: entry.platform,
        displayName: entry.display_name,
      };
    }

    roundRobinIndex.set(rrKey, idx);
  }

  const err = new Error('All models exhausted. Add more API keys or wait for rate limits to reset.') as any;
  err.status = 429;
  throw err;
}
