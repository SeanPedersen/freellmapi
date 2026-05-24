import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/page-header'

interface FallbackEntry {
  modelDbId: number
  score: number
  effectiveScore: number
  penalty: number
  rateLimitHits: number
  successRate: number | null
  totalRequests: number
  tokPerSec: number | null
  avgTtfbMs: number | null
  enabled: boolean
  platform: string
  modelId: string
  displayName: string
  rpmLimit: number | null
  rpdLimit: number | null
  monthlyTokenBudget: string
  keyCount: number
}

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

interface TokenUsageData {
  totalBudget: number
  totalUsed: number
  models: { displayName: string; platform: string; budget: number }[]
}

const platformColors: Record<string, string> = {
  google:      '#4285f4',
  groq:        '#f55036',
  cerebras:    '#8b5cf6',
  sambanova:   '#14b8a6',
  nvidia:      '#76b900',
  mistral:     '#f59e0b',
  openrouter:  '#ec4899',
  github:      '#6e7b8b',
  cohere:      '#d946ef',
  cloudflare:  '#f38020',
  zhipu:       '#06b6d4',
  ollama:      '#000000',
  kilo:        '#7c3aed',
  pollinations: '#a855f7',
  llm7:        '#0ea5e9',
}

function TokenUsageBar({ data }: { data: TokenUsageData }) {
  const [expanded, setExpanded] = useState(false)
  const { totalBudget, totalUsed, models } = data
  const remaining = Math.max(0, totalBudget - totalUsed)
  const remainingPct = totalBudget > 0 ? Math.round((remaining / totalBudget) * 100) : 0

  const modelsWithWidth = models.map(m => ({
    ...m,
    remainingTokens: totalBudget > 0 ? (m.budget / totalBudget) * remaining : 0,
    widthPct: totalBudget > 0 ? (m.budget / totalBudget) * (remaining / totalBudget) * 100 : 0,
  }))
  const usedPct = totalBudget > 0 ? (totalUsed / totalBudget) * 100 : 0

  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-medium">Monthly token budget</h2>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground tabular-nums">
            <span className="text-foreground font-medium">{formatTokens(remaining)}</span> remaining
            <span className="mx-1.5">·</span>
            {remainingPct}% of {formatTokens(totalBudget)}
          </span>
          <button
            onClick={() => setExpanded(v => !v)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? 'Hide models' : `${models.length} models`}
          </button>
        </div>
      </div>

      <div className="flex h-2.5 rounded-full overflow-hidden bg-muted">
        {modelsWithWidth.map((m, i) => (
          <div
            key={i}
            title={`${m.displayName} (${m.platform}) — ${formatTokens(m.remainingTokens)} remaining`}
            style={{
              width: `${m.widthPct}%`,
              backgroundColor: platformColors[m.platform] ?? '#94a3b8',
            }}
          />
        ))}
        {totalUsed > 0 && (
          <div
            title={`Used — ${formatTokens(totalUsed)}`}
            className="bg-muted-foreground/30"
            style={{ width: `${usedPct}%` }}
          />
        )}
      </div>

      {expanded && (
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-1.5 text-xs tabular-nums">
          {modelsWithWidth.map((m, i) => (
            <div key={i} className="flex items-center gap-2 min-w-0">
              <span
                className="size-2 rounded-sm flex-shrink-0"
                style={{ backgroundColor: platformColors[m.platform] ?? '#94a3b8' }}
              />
              <span className="truncate">{m.displayName}</span>
              <span className="flex-1" />
              <span className="font-mono text-muted-foreground">{formatTokens(m.remainingTokens)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function ModelRow({
  entry,
  index,
  onToggle,
}: {
  entry: FallbackEntry
  index: number
  onToggle: (modelDbId: number, enabled: boolean) => void
}) {
  return (
    <div className={`flex items-center gap-3 px-4 py-3 bg-card ${entry.enabled ? '' : 'opacity-50'}`}>
      <span className="text-xs font-mono text-muted-foreground w-5 tabular-nums shrink-0">{index + 1}</span>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{entry.displayName}</span>
          <span className="text-xs text-muted-foreground">{entry.platform}</span>
          {entry.penalty > 0 && (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              −{entry.penalty} penalty ({entry.rateLimitHits} × 429)
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-6 shrink-0">
        <div className="text-right w-14">
          <div className="text-sm font-mono tabular-nums">
            {entry.totalRequests > 0 ? entry.totalRequests : <span className="text-muted-foreground">—</span>}
          </div>
          <div className="text-xs text-muted-foreground">reqs</div>
        </div>
        <div className="text-right w-20">
          <div className="text-sm font-mono tabular-nums">
            {entry.successRate !== null ? `${entry.successRate}%` : <span className="text-muted-foreground">—</span>}
          </div>
          <div className="text-xs text-muted-foreground">success</div>
        </div>
        <div className="text-right w-16">
          <div className="text-sm font-mono tabular-nums">
            {entry.tokPerSec !== null ? entry.tokPerSec : <span className="text-muted-foreground">—</span>}
          </div>
          <div className="text-xs text-muted-foreground">tok/s</div>
        </div>
        <div className="text-right w-20">
          <div className={`text-sm font-mono tabular-nums ${
            entry.avgTtfbMs === null ? 'text-muted-foreground' :
            entry.avgTtfbMs < 500  ? 'text-green-600 dark:text-green-400' :
            entry.avgTtfbMs < 1000 ? 'text-emerald-600 dark:text-emerald-400' :
            entry.avgTtfbMs < 2000 ? 'text-yellow-600 dark:text-yellow-400' :
                                     'text-red-600 dark:text-red-400'
          }`}>
            {entry.avgTtfbMs !== null ? `${entry.avgTtfbMs}ms` : '—'}
          </div>
          <div className="text-xs text-muted-foreground">TTFB</div>
        </div>
        <div className="text-right w-16">
          <div className="text-sm font-mono tabular-nums text-muted-foreground">{entry.score.toFixed(3)}</div>
          <div className="text-xs text-muted-foreground">score</div>
        </div>
      </div>

      <Switch
        checked={entry.enabled}
        onCheckedChange={(checked) => onToggle(entry.modelDbId, checked)}
      />
    </div>
  )
}

export default function FallbackPage() {
  const queryClient = useQueryClient()

  const { data: entries = [], isLoading } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
    refetchInterval: 10_000,
  })

  const { data: tokenUsage } = useQuery<TokenUsageData>({
    queryKey: ['fallback', 'token-usage'],
    queryFn: () => apiFetch('/api/fallback/token-usage'),
    refetchInterval: 30_000,
  })

  const toggleMutation = useMutation({
    mutationFn: ({ modelDbId, enabled }: { modelDbId: number; enabled: boolean }) =>
      apiFetch('/api/fallback', { method: 'PUT', body: JSON.stringify([{ modelDbId, enabled }]) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fallback'] }),
  })

  const displayEntries = entries.filter(e => e.keyCount > 0)
  const unconfiguredPlatforms = [...new Set(entries.filter(e => e.keyCount === 0).map(e => e.platform))]

  return (
    <div>
      <PageHeader
        title="Bandit routing"
        description="Models are ranked by success rate, TTFB, and tok/s over the last 7 days. Toggle to include or exclude from the routing chain."
      />

      <div className="space-y-6">
        {tokenUsage && tokenUsage.totalBudget > 0 && (
          <TokenUsageBar data={tokenUsage} />
        )}

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : displayEntries.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">
              No models available. Add API keys on the <a href="/keys" className="underline text-foreground">Keys page</a> first.
            </p>
          </div>
        ) : (
          <>
            <div className="rounded-lg border divide-y overflow-hidden">
              {displayEntries.map((entry, index) => (
                <ModelRow
                  key={entry.modelDbId}
                  entry={entry}
                  index={index}
                  onToggle={(id, enabled) => toggleMutation.mutate({ modelDbId: id, enabled })}
                />
              ))}
            </div>

            {unconfiguredPlatforms.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Hidden (no keys): {unconfiguredPlatforms.join(', ')}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
