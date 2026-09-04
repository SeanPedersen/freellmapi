import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '../../lib/crypto.js';
import { getDb, initDb } from '../../db/index.js';
import { syncProviderModels } from '../../services/modelDiscovery.js';

describe('model discovery', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  afterEach(() => vi.restoreAllMocks());

  it('upserts a provider catalog, creates fallback entries, and disables stale models', async () => {
    const db = getDb();
    const key = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, status)
      VALUES ('groq', ?, ?, ?, 'healthy')
    `).run(key.encrypted, key.iv, key.authTag);
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank)
      VALUES ('groq', 'removed-model', 'Removed model', 100, 100)
    `).run();

    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [
        { id: 'model-a', name: 'Model A', context_window: 32768 },
        { id: 'model-b' },
      ],
    }), { status: 200 }));

    await expect(syncProviderModels('groq', true)).resolves.toBe(true);

    expect(db.prepare('SELECT model_id, enabled, context_window FROM models WHERE platform = ? ORDER BY model_id').all('groq')).toEqual([
      { model_id: 'model-a', enabled: 1, context_window: 32768 },
      { model_id: 'model-b', enabled: 1, context_window: null },
      { model_id: 'removed-model', enabled: 0, context_window: null },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM fallback_config').get()).toEqual({ count: 2 });
    expect(db.prepare('SELECT platform FROM model_syncs').all()).toEqual([{ platform: 'groq' }]);
  });
});
