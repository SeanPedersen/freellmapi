import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { getSmartAnalyticsScore, refreshStatsCache, routeRequest } from '../../services/router.js';

describe('Router', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare(`
      INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank)
      VALUES ('groq', 'test-model', 'Test model', 100, 100)
    `).run();
    const model = db.prepare("SELECT id FROM models WHERE platform = 'groq' AND model_id = 'test-model'").get() as { id: number };
    db.prepare('INSERT OR IGNORE INTO fallback_config (model_db_id, priority) VALUES (?, 1)').run(model.id);
    // Reset fallback order to intelligence ranking
    const models = db.prepare('SELECT id, intelligence_rank FROM models ORDER BY intelligence_rank ASC').all() as any[];
    const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
    for (let i = 0; i < models.length; i++) {
      update.run(i + 1, models[i].id);
    }
  });

  it('should throw when no keys are configured', () => {
    expect(() => routeRequest()).toThrow(/exhausted/i);
  });

  it('should route to highest priority model with available key', () => {
    const db = getDb();
    const { encrypted, iv, authTag } = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', encrypted, iv, authTag, 'healthy', 1);

    const result = routeRequest();
    expect(result.platform).toBe('groq');
    expect(result.apiKey).toBe('test-groq-key');
  });

  it('should route to an available model when keys exist for multiple platforms', () => {
    const db = getDb();

    const googleKey = encrypt('test-google-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'test', googleKey.encrypted, googleKey.iv, googleKey.authTag, 'healthy', 1);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    const result = routeRequest();
    expect(['google', 'groq']).toContain(result.platform);
  });

  it('should skip disabled keys', () => {
    const db = getDb();

    const googleKey = encrypt('test-google-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'disabled', googleKey.encrypted, googleKey.iv, googleKey.authTag, 'healthy', 0);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    const result = routeRequest();
    expect(result.platform).toBe('groq');
  });

  it('should skip invalid keys', () => {
    const db = getDb();

    const invalidKey = encrypt('invalid-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'invalid', invalidKey.encrypted, invalidKey.iv, invalidKey.authTag, 'invalid', 1);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    const result = routeRequest();
    expect(result.platform).toBe('groq');
  });

  it('auto-smart considers only models with a verified intelligence score', () => {
    const db = getDb();
    db.prepare("UPDATE models SET intelligence_score = NULL").run();
    db.prepare("UPDATE models SET intelligence_score = 84 WHERE platform = 'groq' AND model_id = 'test-model'").run();
    const key = encrypt('smart-key');
    db.prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'smart', ?, ?, ?, 'healthy', 1)`)
      .run(key.encrypted, key.iv, key.authTag);

    expect(routeRequest(1000, undefined, undefined, 'smart').modelId).toBe('test-model');
  });

  it('balanced routing still admits an unscored model', () => {
    const db = getDb();
    db.prepare("UPDATE models SET intelligence_score = NULL").run();
    const key = encrypt('balanced-key');
    db.prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'balanced', ?, ?, ?, 'healthy', 1)`)
      .run(key.encrypted, key.iv, key.authTag);

    expect(routeRequest().modelId).toBe('test-model');
  });

  it('gives a higher absolute AA score a higher smart score under equal metrics', () => {
    expect(getSmartAnalyticsScore('none', 'high', 90)).toBeGreaterThan(
      getSmartAnalyticsScore('none', 'low', 40),
    );
  });

  it('makes AA Intelligence the dominant smart-routing signal', () => {
    const db = getDb();
    const insert = db.prepare(`INSERT INTO requests (platform, model_id, status, latency_ms) VALUES ('test', 'low', 'success', 1)`);
    for (let index = 0; index < 50; index++) insert.run();
    refreshStatsCache(db, true);

    // A high score with a neutral prior outranks a low-score model with perfect history.
    expect(getSmartAnalyticsScore('none', 'high', 52)).toBeGreaterThan(
      getSmartAnalyticsScore('test', 'low', 15.2),
    );
  });
});
