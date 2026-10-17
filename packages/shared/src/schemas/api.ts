import { z } from 'zod';
import { JOB_STATES, JOB_TYPES } from '../constants';

/**
 * API-level job state. Adds two values BullMQ does not have:
 * - `cancelled`: the job was removed by POST /jobs/:id/cancel before it started (tombstone kept by QueueForge).
 * - `unknown`: BullMQ could not place the job in any state (e.g. mid-transition).
 */
export const apiJobStateSchema = z.enum([...JOB_STATES, 'cancelled', 'unknown']);
export type ApiJobState = z.output<typeof apiJobStateSchema>;

export const jobTypeSchema = z.enum(JOB_TYPES);

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
  requestId: z.string(),
});
export type ErrorResponse = z.output<typeof errorResponseSchema>;

export const submitJobResponseSchema = z.object({
  jobId: z.string(),
  status: apiJobStateSchema,
  deduplicated: z.boolean(),
  deduplicationId: z.string().nullable(),
  message: z.string(),
});
export type SubmitJobResponse = z.output<typeof submitJobResponseSchema>;

export const batchSubmitResponseSchema = z.object({
  accepted: z.int(),
  deduplicated: z.int(),
  jobs: z.array(submitJobResponseSchema),
});
export type BatchSubmitResponse = z.output<typeof batchSubmitResponseSchema>;

/**
 * Execution history recorded by QueueForge workers (not by BullMQ). BullMQ keeps counters and the
 * last error per attempt, but not which worker ran which attempt, so workers append these entries
 * to `<prefix>:meta:history:<jobId>`. An attempt with `started` but no matching outcome means the
 * worker disappeared mid-execution (e.g. it was killed); the worker that picks the job up again
 * records a `stalled-recovered` entry before its own `started` entry.
 */
export const executionEventSchema = z.object({
  event: z.enum(['started', 'completed', 'failed', 'stalled-recovered']),
  workerId: z.string(),
  /** BullMQ attemptsStarted after the job became active (1-based execution number). */
  execution: z.int(),
  /** BullMQ attemptsMade at the time of the event. */
  attemptsMade: z.int(),
  at: z.string(),
  message: z.string().optional(),
  willRetry: z.boolean().optional(),
});
export type ExecutionEvent = z.output<typeof executionEventSchema>;

export const jobSummarySchema = z.object({
  id: z.string(),
  type: z.string(),
  state: apiJobStateSchema,
  progress: z.number(),
  attemptsMade: z.int(),
  attemptsStarted: z.int(),
  maxAttempts: z.int(),
  priority: z.int(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  failedReason: z.string().nullable(),
  /** True when the last attempt failed and BullMQ has scheduled another attempt (job is delayed by backoff). */
  awaitingRetry: z.boolean(),
  deduplicationId: z.string().nullable(),
  processedBy: z.string().nullable(),
});
export type JobSummary = z.output<typeof jobSummarySchema>;

export const jobDetailSchema = jobSummarySchema.extend({
  data: z.unknown(),
  result: z.unknown().nullable(),
  stalledCount: z.int(),
  waitingMs: z.number().nullable(),
  backoff: z.object({ type: z.string(), delayMs: z.number() }).nullable(),
  /** First line of each attempt's error, as retained by BullMQ (bounded by stackTraceLimit). */
  attemptErrors: z.array(z.string()),
  history: z.array(executionEventSchema),
  cancelledAt: z.string().nullable(),
});
export type JobDetail = z.output<typeof jobDetailSchema>;

export const listJobsQuerySchema = z.object({
  state: z.enum([...JOB_STATES, 'all']).default('all'),
  type: jobTypeSchema.optional(),
  sort: z.enum(['newest', 'oldest']).default('newest'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
});
export type ListJobsQuery = z.output<typeof listJobsQuerySchema>;

export const listJobsResponseSchema = z.object({
  items: z.array(jobSummarySchema),
  page: z.int(),
  pageSize: z.int(),
  total: z.int(),
  hasMore: z.boolean(),
  /**
   * False when the listing was assembled from a bounded window of each state's most recent jobs
   * (multi-state, type-filtered or searched listings). `total` is then the number of matches in
   * that window, not necessarily in the whole queue.
   */
  exact: z.boolean(),
});
export type ListJobsResponse = z.output<typeof listJobsResponseSchema>;

export const queueStatsSchema = z.object({
  queue: z.string(),
  counts: z.object({
    waiting: z.int(),
    prioritized: z.int(),
    active: z.int(),
    delayed: z.int(),
    completed: z.int(),
    failed: z.int(),
    waitingChildren: z.int(),
  }),
  /** waiting + prioritized: jobs eligible to run as soon as a worker is free. */
  pending: z.int(),
  isPaused: z.boolean(),
  timestamp: z.string(),
});
export type QueueStats = z.output<typeof queueStatsSchema>;

export const workerHeartbeatSchema = z.object({
  workerId: z.string(),
  hostname: z.string(),
  pid: z.int(),
  concurrency: z.int(),
  startedAt: z.string(),
  lastHeartbeatAt: z.string(),
  activeJobs: z.int(),
  processed: z.int(),
  failed: z.int(),
  lockDurationMs: z.int(),
  stalledIntervalMs: z.int(),
  maxStalledCount: z.int(),
  status: z.enum(['running', 'shutting-down']),
});
export type WorkerHeartbeat = z.output<typeof workerHeartbeatSchema>;

export const workersResponseSchema = z.object({
  workers: z.array(
    workerHeartbeatSchema.extend({
      heartbeatAgeMs: z.number(),
      /** Heartbeat younger than two heartbeat intervals. A health estimate, not proof of liveness. */
      fresh: z.boolean(),
    }),
  ),
  heartbeatIntervalMs: z.int(),
  heartbeatTtlSeconds: z.int(),
});
export type WorkersResponse = z.output<typeof workersResponseSchema>;

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'ready', 'not-ready']),
  uptimeSeconds: z.number(),
  checks: z
    .object({
      redis: z.object({ status: z.enum(['up', 'down']), latencyMs: z.number().nullable(), error: z.string().optional() }),
      shuttingDown: z.boolean(),
    })
    .optional(),
});
export type HealthResponse = z.output<typeof healthResponseSchema>;

export const serverConfigSchema = z.object({
  queue: z.string(),
  demoControlsEnabled: z.boolean(),
  retryPolicy: z.object({
    defaultAttempts: z.int(),
    maxAttempts: z.int(),
    defaultBackoffDelayMs: z.int(),
    maxBackoffDelayMs: z.int(),
  }),
  retention: z.object({
    completedCount: z.int(),
    completedAgeSeconds: z.int(),
    failedCount: z.int(),
    failedAgeSeconds: z.int(),
  }),
});
export type ServerConfig = z.output<typeof serverConfigSchema>;

/** Message pushed to dashboards over Server-Sent Events. */
export interface QueueEventMessage {
  /** Redis stream entry id of the BullMQ event (monotonic). */
  id: string;
  event: string;
  jobId: string | null;
  at: string;
  data: Record<string, unknown>;
}
