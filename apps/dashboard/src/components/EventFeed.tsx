import { useEffect, useState } from 'react';
import { Ban, CheckCircle2, CopyX, Inbox, Play, RotateCcw, Siren, Timer, Trash2, XCircle, type LucideIcon } from 'lucide-react';
import type { QueueEventMessage } from '@queueforge/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useDashboard } from '@/context/useDashboard';
import { formatRelative, shortId } from '@/lib/format';
import { cn } from '@/lib/utils';

const EVENT_STYLE: Record<string, { icon: LucideIcon; tone: string; text: (e: QueueEventMessage) => string }> = {
  added: { icon: Inbox, tone: 'text-state-waiting', text: (e) => `Job submitted${e.data.name ? ` (${String(e.data.name)})` : ''}` },
  active: { icon: Play, tone: 'text-state-active', text: () => 'Worker started processing' },
  completed: { icon: CheckCircle2, tone: 'text-state-completed', text: () => 'Completed' },
  failed: { icon: XCircle, tone: 'text-state-failed', text: (e) => `Failed: ${String(e.data.failedReason ?? '')}` },
  'retry-scheduled': {
    icon: RotateCcw,
    tone: 'text-state-delayed',
    text: (e) => `Attempt ${String(e.data.attemptsMade)}/${String(e.data.maxAttempts)} failed, retry scheduled (backoff)`,
  },
  delayed: { icon: Timer, tone: 'text-state-delayed', text: () => 'Delayed' },
  stalled: { icon: Siren, tone: 'text-state-delayed', text: () => 'Stalled: lock expired, returned to queue for recovery' },
  'retries-exhausted': { icon: Ban, tone: 'text-state-failed', text: (e) => `Retries exhausted after ${String(e.data.attemptsMade)} attempts` },
  deduplicated: { icon: CopyX, tone: 'text-muted-foreground', text: () => 'Duplicate submission suppressed' },
  removed: { icon: Trash2, tone: 'text-muted-foreground', text: (e) => `Removed from ${String(e.data.prev ?? 'queue')}` },
};

export function EventFeed({ limit = 40, className }: { limit?: number; className?: string }) {
  const { feed, stream, openJob } = useDashboard();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5_000);
    return () => clearInterval(t);
  }, []);

  return (
    <Card className={cn('h-full min-h-0', className)}>
      <CardHeader>
        <div>
          <CardTitle>Processing events</CardTitle>
          <CardDescription>BullMQ QueueEvents relayed over SSE, from every worker</CardDescription>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn('size-2 rounded-full', stream === 'live' ? 'bg-state-completed' : 'animate-pulse bg-state-delayed')} />
          {stream === 'live' ? 'Live' : stream === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
        </span>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-y-auto">
        {feed.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">Waiting for queue activity…</p>
        ) : (
          <ul className="flex flex-col">
            {feed.slice(0, limit).map((e) => {
              const style = EVENT_STYLE[e.event] ?? { icon: Inbox, tone: 'text-muted-foreground', text: () => e.event };
              const Icon = style.icon;
              return (
                <li key={`${e.id}-${e.event}`} className="flex items-start gap-2.5 border-b py-2 last:border-0">
                  <Icon className={cn('mt-0.5 size-3.5 shrink-0', style.tone)} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs">{style.text(e)}</div>
                    {e.jobId && (
                      <button className="font-mono text-[11px] text-muted-foreground hover:text-primary hover:underline" onClick={() => openJob(e.jobId!)}>
                        {shortId(e.jobId)}
                      </button>
                    )}
                  </div>
                  <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{formatRelative(e.at)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
