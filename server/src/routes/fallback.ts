import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { getAllPenalties, getAnalyticsScores, getAnalyticsScore, getSmartAnalyticsScore, refreshStatsCache, PENALTY_SCORE_WEIGHT } from '../services/router.js';

export const fallbackRouter: Router = Router();

fallbackRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  refreshStatsCache(db, true);
  const rows = db.prepare(`
    SELECT fc.model_db_id, fc.enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.rpm_limit, m.rpd_limit, m.monthly_token_budget
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id AND m.enabled = 1
  `).all() as any[];

  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys WHERE enabled = 1
    GROUP BY platform
  `).all() as { platform: string; count: number }[];
  const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));

  const penalties = getAllPenalties();
  const penaltyMap = new Map(penalties.map(p => [p.modelDbId, p]));

  const analyticsScores = getAnalyticsScores();
  const analyticsMap = new Map(analyticsScores.map(s => [`${s.platform}:${s.modelId}`, s]));

  const intelligenceRanks = rows.map(r => r.intelligence_rank);
  const minIntelligenceRank = Math.min(...intelligenceRanks);
  const maxIntelligenceRank = Math.max(...intelligenceRanks);

  const result = rows.map(r => {
    const penalty = penaltyMap.get(r.model_db_id);
    const analytics = analyticsMap.get(`${r.platform}:${r.model_id}`);
    const score = getAnalyticsScore(r.platform, r.model_id);
    const smartScore = getSmartAnalyticsScore(
      r.platform,
      r.model_id,
      r.intelligence_rank,
      minIntelligenceRank,
      maxIntelligenceRank,
    );
    const penaltyVal = penalty?.penalty ?? 0;
    return {
      modelDbId: r.model_db_id,
      score: Math.round(score * 1000) / 1000,
      smartScore: Math.round(smartScore * 1000) / 1000,
      effectiveScore: Math.round((score - penaltyVal * PENALTY_SCORE_WEIGHT) * 1000) / 1000,
      penalty: penaltyVal,
      rateLimitHits: penalty?.count ?? 0,
      successRate: analytics ? Math.round(analytics.successRate * 1000) / 10 : null,
      totalRequests: analytics?.total ?? 0,
      tokPerSec: analytics ? Math.round(analytics.tokPerSec * 10) / 10 : null,
      avgTtfbMs: analytics?.avgTtfbMs != null ? Math.round(analytics.avgTtfbMs) : null,
      enabled: r.enabled === 1,
      platform: r.platform,
      modelId: r.model_id,
      displayName: r.display_name,
      rpmLimit: r.rpm_limit,
      rpdLimit: r.rpd_limit,
      monthlyTokenBudget: r.monthly_token_budget,
      keyCount: keyCountMap.get(r.platform) ?? 0,
    };
  });

  result.sort((a, b) => b.effectiveScore - a.effectiveScore);

  res.json(result);
});

const updateSchema = z.array(z.object({
  modelDbId: z.number(),
  enabled: z.boolean(),
}));

fallbackRouter.put('/', (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const update = db.prepare('UPDATE fallback_config SET enabled = ? WHERE model_db_id = ?');
  const updateAll = db.transaction(() => {
    for (const entry of parsed.data) {
      update.run(entry.enabled ? 1 : 0, entry.modelDbId);
    }
  });
  updateAll();

  res.json({ success: true });
});

fallbackRouter.get('/token-usage', (_req: Request, res: Response) => {
  const db = getDb();

  const platforms = db.prepare(`
    SELECT DISTINCT ak.platform FROM api_keys ak WHERE ak.enabled = 1
  `).all() as { platform: string }[];
  const platformSet = new Set(platforms.map(p => p.platform));

  const models = db.prepare(`
    SELECT m.platform, m.model_id, m.display_name, m.monthly_token_budget
    FROM models m
    JOIN fallback_config fc ON fc.model_db_id = m.id
    WHERE m.enabled = 1
  `).all() as { platform: string; model_id: string; display_name: string; monthly_token_budget: string }[];

  function parseBudget(s: string): number {
    const m = s.match(/~?([\d.]+)(?:-([\d.]+))?([MK])?/);
    if (!m) return 0;
    const high = parseFloat(m[2] ?? m[1]);
    const unit = m[3] === 'M' ? 1_000_000 : m[3] === 'K' ? 1_000 : 1;
    return high * unit;
  }

  const modelBudgets = models
    .filter(m => platformSet.has(m.platform))
    .map(m => ({
      displayName: m.display_name,
      platform: m.platform,
      budget: parseBudget(m.monthly_token_budget),
    }));

  const totalBudget = modelBudgets.reduce((s, m) => s + m.budget, 0);

  const usage = db.prepare(`
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total_used
    FROM requests
    WHERE created_at >= datetime('now', 'start of month')
  `).get() as { total_used: number };

  res.json({ totalBudget, totalUsed: usage.total_used, models: modelBudgets });
});
