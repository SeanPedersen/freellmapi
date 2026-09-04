import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { applyCachedIntelligenceScores, fetchModelGrepScores, resolveCanonicalModelId, syncIntelligenceScores } from '../../services/intelligenceScores.js';

function page(data: unknown[], meta: Record<string, unknown> = { has_more: false }): Response {
  return new Response(JSON.stringify({ data, meta }), { status: 200 });
}

function scored(id: string, intelligence: number) {
  return { id, benchmarks: { artificial_analysis: { intelligence } } };
}

describe('intelligence scores', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  afterEach(() => vi.restoreAllMocks());

  it('follows ModelGrep pagination and returns verified AA scores', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(page([scored('google/gemini-2.5-flash', 55)], { has_more: true, next_offset: 200 }))
      .mockResolvedValueOnce(page([scored('openai/gpt-oss-120b', 48)]));

    await expect(fetchModelGrepScores()).resolves.toEqual(new Map([
      ['google/gemini-2.5-flash', 55],
      ['openai/gpt-oss-120b', 48],
    ]));
  });

  it('rejects invalid payloads without replacing the verified cache', async () => {
    const db = getDb();
    db.prepare('INSERT INTO modelgrep_scores (model_id, intelligence_score) VALUES (?, ?)').run('google/gemini-2.5-flash', 55);
    vi.spyOn(global, 'fetch').mockResolvedValue(page([{ id: 'google/gemini-2.5-flash', benchmarks: { artificial_analysis: { intelligence: 101 } } }]));

    await expect(syncIntelligenceScores(true)).resolves.toBe(false);
    expect(db.prepare('SELECT * FROM modelgrep_scores').all()).toEqual([
      { model_id: 'google/gemini-2.5-flash', intelligence_score: 55 },
    ]);
  });

  it('ignores catalog entries with no Artificial Analysis score', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(page([
      { id: 'other/benchmark-only', benchmarks: {} },
      scored('google/gemini-2.5-flash', 55),
    ]));

    await expect(fetchModelGrepScores()).resolves.toEqual(new Map([
      ['google/gemini-2.5-flash', 55],
    ]));
  });

  it('resolves canonical provider IDs and only explicit aliases', () => {
    const ids = new Set([
      'google/gemini-2.5-flash', 'meta/llama-3.3-70b', 'openai/gpt-oss-120b',
      'qwen/qwen3.8-27b', 'cohere/command-a', 'inception/mercury-2',
    ]);
    expect(resolveCanonicalModelId('google', 'gemini-2.5-flash', ids)).toBe('google/gemini-2.5-flash');
    expect(resolveCanonicalModelId('cloudflare', '@cf/meta/llama-3.3-70b', ids)).toBe('meta/llama-3.3-70b');
    expect(resolveCanonicalModelId('cerebras', 'gpt-oss-120b', ids)).toBe('openai/gpt-oss-120b');
    expect(resolveCanonicalModelId('cerebras', 'qwen-3.8-27b', ids)).toBe('qwen/qwen3.8-27b');
    expect(resolveCanonicalModelId('cohere', 'command-a-03-2025', ids)).toBe('cohere/command-a');
    expect(resolveCanonicalModelId('inceptionlabs', 'mercury-3', new Set(['inception/mercury-3']))).toBe('inception/mercury-3');
    expect(resolveCanonicalModelId('groq', 'almost-gpt-oss-120b', ids)).toBeNull();
  });

  it('recomputes existing discovered rows from the score cache', () => {
    const db = getDb();
    db.prepare(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank) VALUES ('google', 'gemini-2.5-flash', 'Gemini', 1, 1)`).run();
    db.prepare(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank) VALUES ('groq', 'unknown', 'Unknown', 1, 1)`).run();
    db.prepare('INSERT INTO modelgrep_scores (model_id, intelligence_score) VALUES (?, ?)').run('google/gemini-2.5-flash', 55.5);

    applyCachedIntelligenceScores();
    expect(db.prepare('SELECT model_id, intelligence_score FROM models ORDER BY model_id').all()).toEqual([
      { model_id: 'gemini-2.5-flash', intelligence_score: 55.5 },
      { model_id: 'unknown', intelligence_score: null },
    ]);
  });

  it('reapplies a fresh verified cache without fetching', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank) VALUES ('inceptionlabs', 'mercury-2', 'Mercury', 1, 1)`).run();
    db.prepare('INSERT INTO modelgrep_scores (model_id, intelligence_score) VALUES (?, ?)').run('inception/mercury-2', 21.9);
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('modelgrep_scores_last_synced_at', new Date().toISOString());
    const fetchMock = vi.spyOn(global, 'fetch');

    await expect(syncIntelligenceScores()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.prepare('SELECT intelligence_score FROM models WHERE model_id = ?').get('mercury-2')).toEqual({ intelligence_score: 21.9 });
  });
});
