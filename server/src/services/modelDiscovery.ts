/** Synchronizes provider model catalogs into the local routing database. */
import type { Platform } from '@freellmapi/shared/types.js';
import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { getAllProviders, getProvider } from '../providers/index.js';
import type { DiscoveredModel } from '../providers/base.js';

const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DISCOVERED_INTELLIGENCE_RANK = 100;
const DISCOVERED_SPEED_RANK = 100;

type KeyRow = {
  encrypted_key: string;
  iv: string;
  auth_tag: string;
};

const syncingPlatforms = new Set<Platform>();
let intervalId: ReturnType<typeof setInterval> | null = null;

function modelDisplayName(model: DiscoveredModel): string {
  return model.displayName?.trim() || model.id;
}

function hasFreshSync(platform: Platform): boolean {
  const db = getDb();
  const row = db.prepare(`
    SELECT last_succeeded_at
    FROM model_syncs
    WHERE platform = ?
  `).get(platform) as { last_succeeded_at: string } | undefined;
  if (!row) return false;
  return Date.now() - Date.parse(`${row.last_succeeded_at}Z`) < SYNC_INTERVAL_MS;
}

function saveDiscoveredModels(platform: Platform, models: DiscoveredModel[]): void {
  const db = getDb();
  const uniqueModels = Array.from(new Map(models.map(model => [model.id, model])).values());
  const existing = db.prepare('SELECT id, model_id FROM models WHERE platform = ?').all(platform) as Array<{ id: number; model_id: string }>;
  const discoveredIds = new Set(uniqueModels.map(model => model.id));
  const insertModel = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, context_window, enabled)
    VALUES (?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(platform, model_id) DO UPDATE SET
      display_name = excluded.display_name,
      context_window = COALESCE(excluded.context_window, models.context_window),
      enabled = 1
  `);
  const getModelId = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?');
  const insertFallback = db.prepare(`
    INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled)
    VALUES (?, ?, 1)
  `);
  const disableModel = db.prepare('UPDATE models SET enabled = 0 WHERE id = ?');
  const syncTimestamp = db.prepare(`
    INSERT INTO model_syncs (platform, last_succeeded_at)
    VALUES (?, datetime('now'))
    ON CONFLICT(platform) DO UPDATE SET last_succeeded_at = excluded.last_succeeded_at
  `);

  db.transaction(() => {
    const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS value FROM fallback_config').get() as { value: number }).value;
    for (let index = 0; index < uniqueModels.length; index++) {
      const model = uniqueModels[index];
      insertModel.run(
        platform,
        model.id,
        modelDisplayName(model),
        DISCOVERED_INTELLIGENCE_RANK,
        DISCOVERED_SPEED_RANK,
        model.contextWindow ?? null,
      );
      const row = getModelId.get(platform, model.id) as { id: number };
      insertFallback.run(row.id, maxPriority + index + 1);
    }
    for (const model of existing) {
      if (!discoveredIds.has(model.model_id)) disableModel.run(model.id);
    }
    syncTimestamp.run(platform);
  })();
}

async function fetchProviderModels(platform: Platform): Promise<DiscoveredModel[] | null> {
  const provider = getProvider(platform);
  if (!provider) return null;

  const db = getDb();
  const keys = db.prepare(`
    SELECT encrypted_key, iv, auth_tag
    FROM api_keys
    WHERE platform = ? AND enabled = 1 AND status != 'invalid'
  `).all(platform) as KeyRow[];
  for (const key of keys) {
    try {
      const models = await provider.listModels(decrypt(key.encrypted_key, key.iv, key.auth_tag));
      if (models.length > 0) return models;
      console.warn(`[Models] ${provider.name} returned an empty catalog; keeping the previous catalog.`);
    } catch (error) {
      console.warn(`[Models] ${provider.name} catalog sync failed:`, error instanceof Error ? error.message : error);
    }
  }
  return null;
}

export async function syncProviderModels(platform: Platform, force = false): Promise<boolean> {
  if (!force && hasFreshSync(platform)) return false;
  if (syncingPlatforms.has(platform)) return false;

  syncingPlatforms.add(platform);
  try {
    const models = await fetchProviderModels(platform);
    if (!models) return false;
    saveDiscoveredModels(platform, models);
    console.log(`[Models] Synced ${models.length} models from ${platform}.`);
    return true;
  } finally {
    syncingPlatforms.delete(platform);
  }
}

export async function syncStaleProviderModels(): Promise<void> {
  await Promise.all(getAllProviders().map(provider => syncProviderModels(provider.platform)));
}

export function startModelDiscovery(): void {
  if (intervalId) return;
  console.log(`[Models] Starting catalog sync (every ${SYNC_INTERVAL_MS / 3_600_000}h)`);
  void syncStaleProviderModels();
  intervalId = setInterval(() => void syncStaleProviderModels(), SYNC_INTERVAL_MS);
}

export function stopModelDiscovery(): void {
  if (!intervalId) return;
  clearInterval(intervalId);
  intervalId = null;
}
