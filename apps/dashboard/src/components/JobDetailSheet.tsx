import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Ban, CheckCircle2, Copy, Play, RotateCcw, Siren, XCircle, type LucideIcon } from 'lucide-react';
import type { ExecutionEvent, JobDetail } from '@queueforge/shared';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { StateBadge } from '@/components/StateBadge';
import { useJobAction } from '@/hooks/useJobAction';
import { useDashboard } from '@/context/useDashboard';
import { formatDuration, formatTime, JOB_TYPE_LABELS } from '@/lib/format';
import { cn } from '@/lib/utils';
import { api, ApiError } from '@/services/api';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export function JsonBlock({ value, maxHeight = 'max-h-72' }: { value: unknown; maxHeight?: string }) {
  const text = JSON.stringify(value, null, 2);
  return (
    <div className="group relative">
      <pre className={cn('overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-[11px] leading-relaxed', maxHeight)}>{text}</pre>
      <Button
        size="icon-sm"
        variant="ghost"
        className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100"
        onClick={() => void navigator.clipboard?.writeText(text)}
        aria-label="Copy JSON"
      >
        <Copy />
      </Button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</div>
      <div className="mt-0.5 text-sm tabular-nums">{children}</div>
    </div>
  );
}

const HISTORY_STYLE: Record<ExecutionEvent['event'], { icon: LucideIcon; tone: string; label: string }> = {
  started: { icon: Play, tone: 'text-state-active', label: 'Started' },
  completed: { icon: CheckCircle2, tone: 'text-state-completed', label: 'Completed' },
  failed: { icon: XCircle, tone: 'text-state-failed', label: 'Attempt failed' },
  'stalled-recovered': { icon: Siren, tone: 'text-state-delayed', label: 'Recovered after stall' },
};

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h4 className="text-sm font-semibold">{title}</h4>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

export function JobDetailSheet() {
  const { selectedJobId, closeJob, subscribe, progress } = useDashboard();
  const [loaded, setLoaded] = useState<{ id: string; job: JobDetail | null; error: string | null } | null>(null);
  // Only show data belonging to the currently selected job (avoids flashing the previous one).
  const job = loaded?.id === selectedJobId ? loaded.job : null;
  const error = loaded?.id === selectedJobId ? loaded.error : null;
  const action = useJobAction();

  const load = useCallback(
    (id: string) =>
      api
        .getJob(id)
        .then((j) => setLoaded({ id, job: j, error: null }))
        .catch((err: Error) =>
          setLoaded((prev) => ({
            id,
            job: prev?.id === id ? prev.job : null,
            error:
              err instanceof ApiError && err.status === 404
                ? 'This job no longer exists (removed by retention or never existed).'
                : err.message,
          })),
        ),
    [],
  );

  useEffect(() => {
    if (!selectedJobId) return;
    void load(selectedJobId);
    // Refetch authoritative state whenever the event stream mentions this job...
    const unsubscribe = subscribe((e) => {
      if (e.jobId === selectedJobId && e.event !== 'progress') void load(selectedJobId);
    });
    // ...and poll as a fallback while it is not finished.
    const timer = setInterval(() => void load(selectedJobId), 2_000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [selectedJobId, load, subscribe]);

  const liveProgress = job ? (job.state === 'active' ? Math.max(job.progress, progress[job.id] ?? 0) : job.progress) : 0;
  const isTerminal = job ? TERMINAL.has(job.state) : false;

  return (
    <Sheet open={!!selectedJobId} onOpenChange={(open) => !open && closeJob()}>
      <SheetContent aria-describedby={undefined}>
        <div className="border-b px-6 py-5 pr-12">
          <SheetTitle className="font-mono text-sm break-all">{selectedJobId}</SheetTitle>
          <SheetDescription asChild>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {job && <StateBadge state={job.state} awaitingRetry={job.awaitingRetry} />}
              {job && <span className="text-xs text-muted-foreground">{JOB_TYPE_LABELS[job.type] ?? job.type}</span>}
              {job?.deduplicationId && (
                <span className="rounded border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">dedup: {job.deduplicationId}</span>
              )}
            </div>
          </SheetDescription>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}
          {!job && !error && <div className="text-sm text-muted-foreground">Loading…</div>}
          {job && (
            <div className="flex flex-col gap-6">
              <div>
                <div className="mb-1.5 flex justify-between text-xs">
                  <span className="text-muted-foreground">Progress</span>
                  <span className="font-medium tabular-nums">{Math.round(liveProgress)}%</span>
                </div>
                <Progress
                  value={liveProgress}
                  className="h-2"
                  indicatorClassName={job.state === 'failed' ? 'bg-state-failed' : job.state === 'completed' ? 'bg-state-completed' : undefined}
                />
              </div>

              {job.awaitingRetry && (
                <div className="flex gap-2 rounded-lg border border-state-delayed/40 bg-state-delayed/10 p-3 text-xs">
                  <RotateCcw className="mt-0.5 size-4 shrink-0 text-state-delayed" />
                  <div>
                    <div className="font-medium">Waiting for another attempt</div>
                    <div className="text-muted-foreground">
                      Attempt {job.attemptsMade} of {job.maxAttempts} failed. BullMQ re-queues it after an exponential backoff (
                      {job.backoff ? `${job.backoff.delayMs} ms × 2^(attempt−1)` : 'per job settings'}).
                    </div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Field label="Attempts">
                  {job.attemptsMade} / {job.maxAttempts}
                </Field>
                <Field label="Executions started">{job.attemptsStarted}</Field>
                <Field label="Stall recoveries">{job.stalledCount}</Field>
                <Field label="Created">{formatTime(job.createdAt)}</Field>
                <Field label="Last started">{formatTime(job.startedAt)}</Field>
                <Field label="Finished">{formatTime(job.finishedAt ?? job.cancelledAt)}</Field>
                <Field label="Wait until last start">{formatDuration(job.waitingMs)}</Field>
                <Field label="Duration">{formatDuration(job.durationMs)}</Field>
                <Field label="Last worker">
                  <span className="font-mono text-xs">{job.processedBy ?? '—'}</span>
                </Field>
              </div>

              {(job.failedReason || job.attemptErrors.length > 0) && (
                <Section title="Errors" hint="Error messages retained by BullMQ, one per failed attempt (stack traces are not exposed).">
                  {job.failedReason && (
                    <div className="flex gap-2 rounded-lg border border-state-failed/30 bg-state-failed/5 p-3 text-xs">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-state-failed" />
                      <span className="break-words">{job.failedReason}</span>
                    </div>
                  )}
                  {job.attemptErrors.length > 0 && (
                    <ol className="flex flex-col gap-1 text-xs">
                      {job.attemptErrors.map((e, i) => (
                        <li key={i} className="rounded border bg-muted/40 px-2 py-1 font-mono">
                          <span className="text-muted-foreground">#{i + 1}</span> {e}
                        </li>
                      ))}
                    </ol>
                  )}
                </Section>
              )}

              <Section
                title="Execution timeline"
                hint="Recorded by QueueForge workers (BullMQ itself does not keep per-attempt worker history). A start with no outcome means the worker disappeared."
              >
                {job.history.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No execution recorded yet.</p>
                ) : (
                  <ol className="relative ml-2 border-l pl-5">
                    {job.history.map((h, i) => {
                      const s = HISTORY_STYLE[h.event];
                      const Icon = s.icon;
                      return (
                        <li key={i} className="relative pb-3 last:pb-0">
                          <span className="absolute top-0.5 -left-[29px] flex size-4.5 items-center justify-center rounded-full border bg-card">
                            <Icon className={cn('size-3', s.tone)} />
                          </span>
                          <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
                            <span className="font-medium">{s.label}</span>
                            <span className="font-mono text-muted-foreground">{h.workerId}</span>
                            <span className="text-muted-foreground">execution #{h.execution}</span>
                            <span className="ml-auto font-mono text-[11px] text-muted-foreground">{formatTime(h.at)}</span>
                          </div>
                          {h.message && <div className="mt-0.5 text-xs text-muted-foreground">{h.message}</div>}
                          {h.willRetry !== undefined && (
                            <div className="mt-0.5 text-[11px] text-muted-foreground">{h.willRetry ? 'Will be retried' : 'No retry'}</div>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                )}
              </Section>

              {job.result !== null && (
                <Section title="Result">
                  <JsonBlock value={job.result} />
                </Section>
              )}

              <Section title="Payload">
                <JsonBlock value={job.data} maxHeight="max-h-56" />
              </Section>
            </div>
          )}
        </div>

        {job && !isTerminal && ['waiting', 'prioritized', 'delayed'].includes(job.state) && (
          <div className="flex items-center justify-end gap-2 border-t px-6 py-3">
            {action.error && <span className="mr-auto text-xs text-destructive">{action.error}</span>}
            <Button variant="outline" size="sm" onClick={() => action.run(() => api.cancel(job.id).then(() => load(job.id)))}>
              <Ban /> Cancel job
            </Button>
          </div>
        )}
        {job?.state === 'failed' && (
          <div className="flex items-center justify-end gap-2 border-t px-6 py-3">
            {action.error && <span className="mr-auto text-xs text-destructive">{action.error}</span>}
            <Button size="sm" onClick={() => action.run(() => api.retry(job.id).then(() => load(job.id)))}>
              <RotateCcw /> Retry job
            </Button>
          </div>
        )}
        {job?.state === 'active' && (
          <div className="border-t px-6 py-3 text-xs text-muted-foreground">
            Active jobs cannot be cancelled: QueueForge does not implement cooperative cancellation.
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
