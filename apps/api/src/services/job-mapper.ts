import type { Job } from 'bullmq';
import type { ApiJobState, ExecutionEvent, JobDetail, JobSummary } from '@queueforge/shared';
import { apiJobStateSchema } from '@queueforge/shared';

const iso = (ms: number | undefined | null) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null);

export function normalizeState(state: string): ApiJobState {
  const parsed = apiJobStateSchema.safeParse(state);
  return parsed.success ? parsed.data : 'unknown';
}

/** BullMQ progress may be number | object | string | boolean; QueueForge processors report 0-100. */
export function normalizeProgress(progress: unknown): number {
  if (typeof progress === 'number' && Number.isFinite(progress)) return Math.max(0, Math.min(100, progress));
  return 0;
}

/** First line of an error stack ("Error: message"), which is safe to show publicly. */
export function firstLine(stack: string): string {
  return stack.split('\n', 1)[0]!.slice(0, 500);
}

type MappableJob = Pick<
  Job,
  | 'id'
  | 'name'
  | 'data'
  | 'opts'
  | 'progress'
  | 'attemptsMade'
  | 'attemptsStarted'
  | 'stalledCounter'
  | 'priority'
  | 'timestamp'
  | 'processedOn'
  | 'finishedOn'
  | 'failedReason'
  | 'returnvalue'
  | 'stacktrace'
  | 'deduplicationId'
  | 'processedBy'
>;

export function toJobSummary(job: MappableJob, rawState: string): JobSummary {
  const state = normalizeState(rawState);
  const maxAttempts = job.opts.attempts ?? 1;
  return {
    id: job.id!,
    type: job.name,
    state,
    progress: state === 'completed' ? 100 : normalizeProgress(job.progress),
    attemptsMade: job.attemptsMade,
    attemptsStarted: job.attemptsStarted ?? 0,
    maxAttempts,
    priority: job.priority ?? 0,
    createdAt: iso(job.timestamp) ?? new Date(0).toISOString(),
    startedAt: iso(job.processedOn),
    finishedAt: state === 'completed' || state === 'failed' ? iso(job.finishedOn) : null,
    durationMs:
      (state === 'completed' || state === 'failed') && job.processedOn && job.finishedOn
        ? job.finishedOn - job.processedOn
        : null,
    failedReason: job.failedReason || null,
    // A delayed job with failed attempts is waiting out its backoff before the next attempt.
    awaitingRetry: state === 'delayed' && job.attemptsMade > 0 && job.attemptsMade < maxAttempts,
    deduplicationId: job.deduplicationId ?? null,
    processedBy: job.processedBy ?? null,
  };
}

export function toJobDetail(job: MappableJob, rawState: string, history: ExecutionEvent[]): JobDetail {
  const summary = toJobSummary(job, rawState);
  const backoff = job.opts.backoff;
  return {
    ...summary,
    data: job.data ?? null,
    result: summary.state === 'completed' ? (job.returnvalue ?? null) : null,
    stalledCount: job.stalledCounter ?? 0,
    waitingMs: job.processedOn ? job.processedOn - job.timestamp : null,
    backoff:
      typeof backoff === 'object' && backoff
        ? { type: backoff.type, delayMs: backoff.delay ?? 0 }
        : typeof backoff === 'number'
          ? { type: 'fixed', delayMs: backoff }
          : null,
    attemptErrors: (job.stacktrace ?? []).map(firstLine),
    history,
    cancelledAt: null,
  };
}
