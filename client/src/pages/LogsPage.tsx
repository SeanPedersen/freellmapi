import { useRef, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'

type LogLevel = 'info' | 'warn' | 'error'

interface LogEntry {
  id: number
  timestamp: string
  level: LogLevel
  message: string
}

const LEVEL_STYLES: Record<LogLevel, string> = {
  info: 'text-foreground',
  warn: 'text-yellow-500',
  error: 'text-destructive',
}

const LEVEL_LABELS: Record<LogLevel, string> = {
  info: 'INFO',
  warn: 'WARN',
  error: 'ERR ',
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

const FOLLOW_THRESHOLD_PX = 60

export default function LogsPage() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [v1Only, setV1Only] = useState(true)
  const [isFollowing, setIsFollowing] = useState(true)

  const { data: logs = [], dataUpdatedAt } = useQuery({
    queryKey: ['logs'],
    queryFn: () => apiFetch<LogEntry[]>('/api/logs'),
    refetchInterval: 2000,
  })

  const NOISE_PREFIXES = ['[HTTP] GET /api/logs', '[HTTP] GET /api/ping']
  const cleanLogs = logs.filter(e => !NOISE_PREFIXES.some(p => e.message.startsWith(p)))

  const visibleLogs = v1Only
    ? cleanLogs.filter(e =>
        e.message.includes('/v1/')
        || e.message.startsWith('[Model Response]')
        || e.message.startsWith('[Proxy]')
        || e.message.startsWith('[Request]')
        || e.message.startsWith('[Session]')
        || e.message.startsWith('[Sticky]')
      )
    : cleanLogs

  function handleScroll() {
    const el = containerRef.current
    if (!el) return
    setIsFollowing(el.scrollTop <= FOLLOW_THRESHOLD_PX)
  }

  function scrollToTop() {
    containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    setIsFollowing(true)
  }

  useEffect(() => {
    if (isFollowing) {
      containerRef.current?.scrollTo({ top: 0 })
    }
  }, [dataUpdatedAt, isFollowing])

  return (
    <div className="flex flex-col h-[calc(100vh-10rem)]">
      <PageHeader
        title="Logs"
        description="Live server logs — newest entries at the top."
        actions={
          <div className="flex gap-1 rounded-md border p-0.5">
            <Button
              variant={v1Only ? 'secondary' : 'ghost'}
              size="xs"
              onClick={() => setV1Only(true)}
            >
              /v1 only
            </Button>
            <Button
              variant={!v1Only ? 'secondary' : 'ghost'}
              size="xs"
              onClick={() => setV1Only(false)}
            >
              All
            </Button>
          </div>
        }
      />

      <div className="relative flex-1 min-h-0">
        {!isFollowing && (
          <button
            onClick={scrollToTop}
            className="absolute top-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs font-medium shadow-sm hover:bg-muted transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m18 15-6-6-6 6"/></svg>
            Back to live
          </button>
        )}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto rounded-lg border bg-card font-mono text-xs"
      >
        {visibleLogs.length === 0 ? (
          <p className="text-muted-foreground p-4">{logs.length === 0 ? 'No logs yet.' : 'No /v1 traffic yet.'}</p>
        ) : (
          <table className="w-full border-collapse">
            <tbody>
              {visibleLogs.map(entry => (
                <tr
                  key={entry.id}
                  className="border-b border-border/40 hover:bg-muted/30 transition-colors"
                >
                  <td className="pl-4 pr-3 py-1.5 text-muted-foreground whitespace-nowrap w-20 tabular-nums select-none">
                    {formatTimestamp(entry.timestamp)}
                  </td>
                  <td className={`pr-3 py-1.5 whitespace-nowrap w-10 font-semibold select-none ${LEVEL_STYLES[entry.level]}`}>
                    {LEVEL_LABELS[entry.level]}
                  </td>
                  <td className={`pr-4 py-1.5 break-all ${LEVEL_STYLES[entry.level]}`}>
                    {entry.message}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      </div>
    </div>
  )
}
