/** Name of the single BullMQ queue used by QueueForge. The job name carries the job type. */
export const QUEUE_NAME = 'queueforge';

/** Default Redis key prefix. BullMQ keys live under `<prefix>:<queue>:*`; QueueForge's own keys under `<prefix>:meta:*`. */
export const DEFAULT_KEY_PREFIX = 'qf';

export const JOB_TYPES = ['report-generation', 'data-transformation', 'failure-simulation'] as const;
export type JobType = (typeof JOB_TYPES)[number];

/**
 * BullMQ job states. `prioritized` is a distinct state in BullMQ: jobs added with a
 * priority wait in a sorted set instead of the plain wait list.
 */
export const JOB_STATES = [
  'waiting',
  'prioritized',
  'active',
  'delayed',
  'completed',
  'failed',
  'waiting-children',
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** Server-defined retry policy. Clients may tune it only within these bounds. */
export const RETRY_POLICY = {
  defaultAttempts: 3,
  minAttempts: 1,
  maxAttempts: 5,
  defaultBackoffDelayMs: 1000,
  minBackoffDelayMs: 100,
  maxBackoffDelayMs: 10_000,
} as const;

export const PRIORITY_LIMITS = { min: 1, max: 10 } as const;

/** Input bounds. These keep a single job from monopolising a worker or Redis memory. */
export const LIMITS = {
  report: { maxRecords: 200_000, maxBatchDelayMs: 2_000, batchSize: 500 },
  transformation: { maxRecords: 5_000, maxFields: 50, maxOperations: 10, maxStringLength: 1_000 },
  simulation: { minDurationMs: 0, maxDurationMs: 120_000, maxFailFirstAttempts: 10, maxSteps: 100 },
  batchSubmit: { maxJobs: 100 },
  deduplicationKey: { maxLength: 128 },
  bodyLimitBytes: 1_048_576,
} as const;

/** How long QueueForge's own per-job metadata (history, side-effect ledger) is kept in Redis. */
export const METADATA_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Worker heartbeat key TTL. A worker that stops heartbeating disappears after this. */
export const HEARTBEAT_TTL_SECONDS = 15;
export const HEARTBEAT_INTERVAL_MS = 5_000;

/** Job IDs are generated server-side as `job_<uuid without dashes>`. Accept a conservative charset on lookup. */
export const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
