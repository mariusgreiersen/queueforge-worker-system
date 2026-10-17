import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { z } from 'zod';
import { DEFAULT_KEY_PREFIX, QUEUE_NAME } from '@queueforge/shared';
import { envBoolean, envInt, parseEnv } from '@queueforge/shared/node';

const workerEnvSchema = z.object({
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  QUEUE_PREFIX: z.string().regex(/^[A-Za-z0-9_-]+$/).default(DEFAULT_KEY_PREFIX),
  QUEUE_NAME: z.string().regex(/^[A-Za-z0-9_-]+$/).default(QUEUE_NAME),
  WORKER_ID: z.string().regex(/^[A-Za-z0-9_.-]+$/).optional(),
  WORKER_CONCURRENCY: envInt(3, 1, 50),
  /** How long a worker's lock on an active job lasts without renewal. Renewed every lockDuration / 2. */
  WORKER_LOCK_DURATION_MS: envInt(15_000, 1_000, 600_000),
  /** How often each worker scans for active jobs whose lock has expired. */
  WORKER_STALLED_INTERVAL_MS: envInt(5_000, 500, 600_000),
  /** Times a job may be recovered from a stall before BullMQ fails it (prevents infinite recovery loops). */
  WORKER_MAX_STALLED_COUNT: envInt(2, 0, 10),
  /** Upper bound on graceful shutdown before the process exits and leaves jobs to stalled recovery. */
  WORKER_SHUTDOWN_TIMEOUT_MS: envInt(25_000, 0, 600_000),
  /** LOCAL DEVELOPMENT ONLY: accept a "crash" command over Redis pub/sub and SIGKILL this process. */
  WORKER_ALLOW_CRASH_COMMANDS: envBoolean(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: envBoolean(false),
});

export interface WorkerConfig {
  redisUrl: string;
  prefix: string;
  queueName: string;
  workerId: string;
  concurrency: number;
  lockDurationMs: number;
  stalledIntervalMs: number;
  maxStalledCount: number;
  shutdownTimeoutMs: number;
  allowCrashCommands: boolean;
  logLevel: string;
  logPretty: boolean;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const e = parseEnv(workerEnvSchema, env);
  return {
    redisUrl: e.REDIS_URL,
    prefix: e.QUEUE_PREFIX,
    queueName: e.QUEUE_NAME,
    // hostname-pid alone is not unique over time: a restarted container reuses both, so a crashed
    // worker and its replacement would share an id. A per-process random suffix disambiguates.
    workerId: e.WORKER_ID ?? `${hostname()}-${process.pid}-${randomBytes(2).toString('hex')}`,
    concurrency: e.WORKER_CONCURRENCY,
    lockDurationMs: e.WORKER_LOCK_DURATION_MS,
    stalledIntervalMs: e.WORKER_STALLED_INTERVAL_MS,
    maxStalledCount: e.WORKER_MAX_STALLED_COUNT,
    shutdownTimeoutMs: e.WORKER_SHUTDOWN_TIMEOUT_MS,
    allowCrashCommands: e.WORKER_ALLOW_CRASH_COMMANDS,
    logLevel: e.LOG_LEVEL,
    logPretty: e.LOG_PRETTY,
  };
}
