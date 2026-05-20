import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend,
} from 'recharts'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/page-header'

type TimeRange = '24h' | '7d' | '30d'

function formatTokens(n?: number): string {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function Stat({ label, value, className }: { label: string; value: string | number; className?: string }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={`text-xl font-semibold tabular-nums mt-1 ${className ?? ''}`}>{value}</p>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card">
      <div className="px-4 py-3 border-b">
        <h3 className="text-sm font-medium">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

const axisStyle = { fontSize: 11, fill: 'var(--muted-foreground)' } as const
const gridStyle = 'var(--border)'
const primaryFill = 'var(--foreground)'

type SortKey = 'displayName' | 'platform' | 'requests' | 'successRate' | 'avgLatencyMs' | 'avgTtfbMs' | 'totalInputTokens' | 'totalOutputTokens' | 'outputTokensPerSec'
type SortDir = 'asc' | 'desc'

function sortModels(rows: any[], key: SortKey, dir: SortDir) {
  return [...rows].sort((a, b) => {
    const av = a[key] ?? (typeof a[key] === 'number' ? -Infinity : '')
    const bv = b[key] ?? (typeof b[key] === 'number' ? -Infinity : '')
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : (av as number) - (bv as number)
    return dir === 'asc' ? cmp : -cmp
  })
}

function SortableHead({ label, sortKey, current, dir, onSort, className }: {
  label: string; sortKey: SortKey; current: SortKey; dir: SortDir
  onSort: (k: SortKey) => void; className?: string
}) {
  const active = current === sortKey
  return (
    <TableHead
      className={`sticky top-0 z-10 bg-card cursor-pointer select-none hover:text-foreground ${active ? 'text-foreground' : ''} ${className ?? ''}`}
      onClick={() => onSort(sortKey)}
    >
      {label}{active ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </TableHead>
  )
}

export default function AnalyticsPage() {
  const [range, setRange] = useState<TimeRange>('7d')
  const [sortKey, setSortKey] = useState<SortKey>('requests')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  function handleSort(key: SortKey) {
    if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  const { data: summary } = useQuery({
    queryKey: ['analytics', 'summary', range],
    queryFn: () => apiFetch<any>(`/api/analytics/summary?range=${range}`),
  })

  const { data: byPlatform = [] } = useQuery({
    queryKey: ['analytics', 'by-platform', range],
    queryFn: () => apiFetch<any[]>(`/api/analytics/by-platform?range=${range}`),
  })

  const { data: timeline = [] } = useQuery({
    queryKey: ['analytics', 'timeline', range],
    queryFn: () => apiFetch<any[]>(`/api/analytics/timeline?range=${range}`),
  })

  const { data: byModel = [] } = useQuery({
    queryKey: ['analytics', 'by-model', range],
    queryFn: () => apiFetch<any[]>(`/api/analytics/by-model?range=${range}`),
  })

  const { data: errors = [] } = useQuery({
    queryKey: ['analytics', 'errors', range],
    queryFn: () => apiFetch<any[]>(`/api/analytics/errors?range=${range}`),
  })

  const byPlatformWithFailures = byPlatform.map((p: any) => {
    const failed = Math.round(p.requests * (100 - p.successRate) / 100)
    return { ...p, successRequests: p.requests - failed, failedRequests: failed }
  })

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Request volume, latency, token usage, and failures."
        actions={
          <div className="flex gap-1 rounded-md border p-0.5">
            {(['24h', '7d', '30d'] as TimeRange[]).map(r => (
              <Button
                key={r}
                variant={range === r ? 'secondary' : 'ghost'}
                size="xs"
                onClick={() => setRange(r)}
              >
                {r}
              </Button>
            ))}
          </div>
        }
      />

      <div className="space-y-6">
        {/* Summary stats */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Stat label="Requests" value={summary?.totalRequests ?? 0} />
          <Stat label="Success rate" value={`${summary?.successRate ?? 0}%`} />
          <Stat label="Input tokens" value={formatTokens(summary?.totalInputTokens)} />
          <Stat label="Output tokens" value={formatTokens(summary?.totalOutputTokens)} />
          <Stat label="Avg latency" value={`${summary?.avgLatencyMs ?? 0} ms`} />
          <Stat label="Est. savings" value={`$${summary?.estimatedCostSavings ?? '0.00'}`} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Panel title="Requests by provider">
            {byPlatformWithFailures.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No data yet</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatformWithFailures} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="failedRequests" name="Failed" stackId="a" fill="var(--destructive)" />
                  <Bar dataKey="successRequests" name="Success" stackId="a" fill={primaryFill} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <Panel title="Tok/sec by provider">
            {byPlatform.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No data yet</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis unit=" t/s" tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="outputTokensPerSec" name="Tok/sec" fill="var(--muted-foreground)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <div className="lg:col-span-2">
            <Panel title="Requests over time">
              {timeline.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No data yet</p>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={timeline} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                    <XAxis dataKey="timestamp" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                    <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} iconType="line" />
                    <Line type="monotone" dataKey="successCount" name="Success" stroke={primaryFill} strokeWidth={1.5} dot={false} />
                    <Line type="monotone" dataKey="failureCount" name="Failures" stroke="var(--destructive)" strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </Panel>
          </div>

          <div className="lg:col-span-2">
            <Panel title="Per-model breakdown">
              {byModel.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No data yet</p>
              ) : (
                <div className="max-h-[360px] overflow-y-auto -mx-4 -mt-4">
                  <table className="w-full caption-bottom text-sm">
                    <TableHeader>
                      <TableRow>
                        <SortableHead label="Model" sortKey="displayName" current={sortKey} dir={sortDir} onSort={handleSort} className="pl-4" />
                        <SortableHead label="Provider" sortKey="platform" current={sortKey} dir={sortDir} onSort={handleSort} />
                        <SortableHead label="Requests" sortKey="requests" current={sortKey} dir={sortDir} onSort={handleSort} className="text-right" />
                        <SortableHead label="Success" sortKey="successRate" current={sortKey} dir={sortDir} onSort={handleSort} className="text-right" />
                        <SortableHead label="Latency" sortKey="avgLatencyMs" current={sortKey} dir={sortDir} onSort={handleSort} className="text-right" />
                        <SortableHead label="TTFB" sortKey="avgTtfbMs" current={sortKey} dir={sortDir} onSort={handleSort} className="text-right" />
                        <SortableHead label="In tokens" sortKey="totalInputTokens" current={sortKey} dir={sortDir} onSort={handleSort} className="text-right" />
                        <SortableHead label="Out tokens" sortKey="totalOutputTokens" current={sortKey} dir={sortDir} onSort={handleSort} className="text-right" />
                        <SortableHead label="tok/s" sortKey="outputTokensPerSec" current={sortKey} dir={sortDir} onSort={handleSort} className="text-right pr-4" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortModels(byModel, sortKey, sortDir).map((m: any, i: number) => (
                        <TableRow key={i}>
                          <TableCell className="pl-4 text-sm font-medium">{m.displayName}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{m.platform}</TableCell>
                          <TableCell className="text-right tabular-nums">{m.requests}</TableCell>
                          <TableCell className="text-right tabular-nums">{m.successRate}%</TableCell>
                          <TableCell className="text-right tabular-nums">{m.avgLatencyMs} ms</TableCell>
                          <TableCell className="text-right tabular-nums">{m.avgTtfbMs != null ? `${m.avgTtfbMs} ms` : '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatTokens(m.totalInputTokens)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatTokens(m.totalOutputTokens)}</TableCell>
                          <TableCell className="text-right tabular-nums pr-4">{m.outputTokensPerSec != null ? m.outputTokensPerSec : '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </table>
                </div>
              )}
            </Panel>
          </div>

          <Panel title="Recent errors">
            {errors.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No errors</p>
            ) : (
              <div className="max-h-[240px] overflow-y-auto -mx-4 -mt-4">
                <table className="w-full caption-bottom text-sm">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="sticky top-0 z-10 bg-card pl-4">Provider</TableHead>
                      <TableHead className="sticky top-0 z-10 bg-card">Message</TableHead>
                      <TableHead className="sticky top-0 z-10 bg-card text-right pr-4">Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {errors.slice(0, 20).map((e: any) => (
                      <TableRow key={e.id}>
                        <TableCell className="pl-4 text-xs">{e.platform}</TableCell>
                        <TableCell className="text-xs max-w-[200px] truncate">{e.error}</TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground tabular-nums pr-4">
                          {new Date(e.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  )
}
