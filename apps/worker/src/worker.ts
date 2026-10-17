import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { appendHistory, metaKeys, readHistory, redisOptions, type Logger } from '@queueforge/shared/node';
import type { WorkerConfig } from './config';
import { classifyError, errorMessage } from './errors';
import { createJobHandler } from './handlers/dispatch';
import { Heartbeat } from './heartbeat';

export interface QueueForgeWorker {
  worker: Worker;
  config: WorkerConfig;
  /** Graceful close: stop fetching, wait for active jobs, release connections. */
  close: () => Promise<void>;
}

const jobLogFields = (job: Job | undefined) =>
  job
    ? { jobId: job.id, jobType: job.name, attempt: job.attemptsMade, maxAttempts: job.opts.attempts ?? 1 }
    : {};

export async function startWorker(config: WorkerConfig, rootLogger: Logger): Promise<QueueForgeWorker> {
  const logger = rootLogger.child({ workerId: config.workerId, queue: config.queueName });
  const keys = metaKeys(config.prefix);
  const redis = new Redis(redisOptions(config.redisUrl, 'blocking', `qf-worker-meta:${config.workerId}`));
  redis.on('error', (err) => logger.warn({ err: err.message, event: 'redis.error' }, 'Metadata Redis connection error'));

  const stats = { activeJobs: 0, processed: 0, failed: 0 };

  // History is an audit trail. Failing to write it must not fail (or mask the error of) a job.
  const recordHistory: Parameters<typeof createJobHandler>[0]['recordHistory'] = async (jobId, event) => {
    try {
      await appendHistory(redis, keys, jobId, event);
    } catch (err) {
      logger.warn({ jobId, err: errorMessage(err) }, 'Could not record execution history');
    }
  };

  const loadHistory = (jobId: string) => readHistory(redis, keys, jobId).catch(() => []);
  const handle = createJobHandler({ redis, keys, workerId: config.workerId, logger, recordHistory, loadHistory });

  const worker = new Worker(
    config.queueName,
    async (job) => {
      stats.activeJobs += 1;
      try {
        return await handle(job);
      } finally {
        stats.activeJobs -= 1;
      }
    },
    {
      connection: redisOptions(config.redisUrl, 'blocking', `qf-worker:${config.workerId}`),
      prefix: config.prefix,
      name: config.workerId,
      concurrency: config.concurrency,
      lockDuration: config.lockDurationMs,
      stalledInterval: config.stalledIntervalMs,
      maxStalledCount: config.maxStalledCount,
      autorun: false,
    },
  );

  worker.on('completed', (job) => {
    stats.processed += 1;
    const durationMs = job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : undefined;
    logger.info({ event: 'job.completed', ...jobLogFields(job), durationMs }, 'Job completed');
  });

  worker.on('failed', (job, err) => {
    stats.failed += 1;
    const errorClass = classifyError(err);
    const willRetry = !!job && errorClass === 'transient' && job.attemptsMade < (job.opts.attempts ?? 1);
    if (willRetry) {
      logger.warn(
        { event: 'job.retry_scheduled', ...jobLogFields(job), errorClass, error: err.message },
        'Attempt failed; retry scheduled with backoff',
      );
    } else {
      logger.error(
        { event: 'job.failed', ...jobLogFields(job), errorClass, error: err.message },
        'Job failed permanently',
      );
    }
  });

  // Emitted by the worker whose stalled checker found an active job without a valid lock and moved
  // it back to wait (or to failed once maxStalledCount is exceeded).
  worker.on('stalled', (jobId, prev) => {
    logger.warn({ event: 'job.stalled', jobId, prev }, 'Stalled job detected; returned to the queue for recovery');
  });

  worker.on('error', (err) => logger.error({ event: 'worker.error', err: err.message }, 'Worker error'));

  const heartbeat = new Heartbeat(redis, keys, config, () => ({ ...stats }), logger);

  let control: Redis | undefined;
  if (config.allowCrashCommands) {
    control = new Redis(redisOptions(config.redisUrl, 'blocking', `qf-worker-control:${config.workerId}`));
    control.on('error', () => undefined);
    await control.subscribe(keys.controlChannel(config.workerId));
    control.on('message', (_channel, message) => {
      if (message !== 'crash') return;
      // Intentionally abrupt: no graceful close, locks are not released, the job is left active.
      // This is the failure mode stalled-job recovery exists for.
      process.stderr.write(`[${config.workerId}] crash command received; terminating with SIGKILL\n`);
      // The kernel ignores SIGKILL that PID 1 sends to itself inside a container. Compose runs
      // workers under an init process (init: true) to avoid that; abort() is the fallback.
      if (process.pid === 1) process.abort();
      process.kill(process.pid, 'SIGKILL');
    });
    logger.warn({ event: 'worker.crash_commands_enabled' }, 'Crash commands ENABLED (local development only)');
  }

  void worker.run();
  await worker.waitUntilReady();
  heartbeat.start();
  logger.info(
    {
      event: 'worker.started',
      concurrency: config.concurrency,
      lockDurationMs: config.lockDurationMs,
      stalledIntervalMs: config.stalledIntervalMs,
      maxStalledCount: config.maxStalledCount,
      pid: process.pid,
    },
    'Worker started',
  );

  return {
    worker,
    config,
    close: async () => {
      logger.info({ event: 'worker.shutting_down', activeJobs: stats.activeJobs }, 'Worker shutting down');
      await heartbeat.markShuttingDown();
      await worker.close();
      await heartbeat.stop();
      if (control) await control.quit().catch(() => undefined);
      await redis.quit().catch(() => undefined);
      logger.info({ event: 'worker.stopped', processed: stats.processed }, 'Worker stopped');
    },
  };
}
