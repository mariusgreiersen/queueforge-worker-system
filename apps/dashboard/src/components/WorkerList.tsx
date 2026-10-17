import { useState } from 'react';
import { Cpu, HeartPulse, Info, Skull } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useDashboard } from '@/context/useDashboard';
import { formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';
import { api, ApiError } from '@/services/api';

export function WorkerList({ compact = false }: { compact?: boolean }) {
  const { workers, config, refresh } = useDashboard();
  const [message, setMessage] = useState<string | null>(null);
  const list = workers?.workers ?? [];

  const crash = async (workerId: string) => {
    setMessage(null);
    try {
      const res = await api.crashWorker(workerId);
      setMessage(res.message);
    } catch (err) {
      setMessage(err instanceof ApiError ? `${err.code}: ${err.message}` : (err as Error).message);
    }
    setTimeout(refresh, 1_000);
  };

  return (
    <Card className="h-full">
      <CardHeader>
        <div>
          <CardTitle>Workers</CardTitle>
          <CardDescription>
            Heartbeat every {(workers?.heartbeatIntervalMs ?? 5000) / 1000}s, TTL {workers?.heartbeatTtlSeconds ?? 15}s
          </CardDescription>
        </div>
        <span className="text-2xl font-semibold tabular-nums">{list.filter((w) => w.fresh).length}</span>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5">
        {list.length === 0 && (
          <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
            No worker heartbeats. Start one with <code className="font-mono">npm run dev:worker</code> or{' '}
            <code className="font-mono">docker compose up</code>.
          </p>
        )}
        {list.map((w) => (
          <div key={w.workerId} className="rounded-lg border p-3">
            <div className="flex items-center gap-2">
              <Cpu className="size-4 text-muted-foreground" />
              <span className="truncate font-mono text-xs font-medium" title={w.workerId}>
                {w.workerId}
              </span>
              <span
                className={cn(
                  'ml-auto inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]',
                  w.fresh ? 'text-foreground' : 'text-muted-foreground',
                )}
                title="Heartbeat-based estimate. Job ownership is decided by BullMQ locks, not by this indicator."
              >
                <HeartPulse className={cn('size-3', w.fresh ? 'text-state-completed' : 'text-state-delayed')} />
                {w.status === 'shutting-down' ? 'shutting down' : w.fresh ? 'fresh' : 'stale'}
              </span>
            </div>
            <div className={cn('mt-2 grid gap-x-3 gap-y-1 text-[11px] text-muted-foreground', compact ? 'grid-cols-3' : 'grid-cols-3 sm:grid-cols-6')}>
              <span>
                active <b className="font-medium text-foreground tabular-nums">{w.activeJobs}</b>/{w.concurrency}
              </span>
              <span>
                done <b className="font-medium text-foreground tabular-nums">{w.processed}</b>
              </span>
              <span>
                failed <b className="font-medium text-foreground tabular-nums">{w.failed}</b>
              </span>
              {!compact && (
                <>
                  <span>
                    beat <b className="font-medium text-foreground tabular-nums">{formatDuration(w.heartbeatAgeMs)}</b> ago
                  </span>
                  <span>
                    lock <b className="font-medium text-foreground">{w.lockDurationMs / 1000}s</b>
                  </span>
                  <span>
                    pid <b className="font-medium text-foreground">{w.pid}</b>
                  </span>
                </>
              )}
            </div>
            {!compact && config?.demoControlsEnabled && (
              <div className="mt-2.5 flex justify-end">
                <Button size="sm" variant="outline" className="text-destructive" onClick={() => void crash(w.workerId)}>
                  <Skull /> Crash (SIGKILL)
                </Button>
              </div>
            )}
          </div>
        ))}
        {message && <p className="text-xs text-muted-foreground">{message}</p>}
        {!compact && (
          <p className="flex gap-1.5 text-[11px] text-muted-foreground">
            <Info className="mt-0.5 size-3 shrink-0" />
            “Fresh” means a heartbeat arrived in the last two intervals. It is a health estimate, not proof that the process is alive.
            Counts are per worker process since it started.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
