import { randomBytes } from 'node:crypto';
import { Queue, QueueEvents, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { inject } from 'vitest';
import { QUEUE_NAME } from '@queueforge/shared';
import { createLogger, metaKeys, redisOptions } from '@queueforge/shared/node';
import { loadApiConfig, type ApiConfig } from '../../apps/api/src/config';
import { loadWorkerConfig, type WorkerConfig } from '../../apps/worker/src/config';
import { startWorker, type QueueForgeWorker } from '../../apps/worker/src/worker';

export const silentLogger = createLogger({ service: 'test', level: 'silent', pretty: false });

/**
 * Per-file isolation: every test file gets its own key prefix, so suites never see each other's
 * jobs even when they share one Redis. Keys are deleted in `cleanup()`.
 */
export function createTestContext(name: string) {
  const redisUrl = inject('redisUrl');
  const prefix = `qft-${name}-${randomBytes(3).toString('hex')}`;
  const keys = metaKeys(prefix);
  const redis = new Redis(redisOptions(redisUrl, 'blocking', 'qf-test'));
  const queue = new Queue(QUEUE_NAME, { connection: redisOptions(redisUrl, 'blocking', 'qf-test-queue'), prefix });
  const events = new QueueEvents(QUEUE_NAME, { connection: redisOptions(redisUrl, 'blocking', 'qf-test-events'), prefix });
  // Many concurrent waitUntilFinished() calls each add listeners; that's expected in tests.
  queue.setMaxListeners(200);
  events.setMaxListeners(200);
  const workers: QueueForgeWorker[] = [];

  const apiConfig = (env: Record<string, string> = {}): ApiConfig =>
    loadApiConfig({ REDIS_URL: redisUrl, QUEUE_PREFIX: prefix, LOG_LEVEL: 'silent', ...env });

  const workerConfig = (env: Record<string, string> = {}): WorkerConfig =>
    loadWorkerConfig({
      REDIS_URL: redisUrl,
      QUEUE_PREFIX: prefix,
      WORKER_ID: `inproc-${randomBytes(2).toString('hex')}`,
      LOG_LEVEL: 'silent',
      ...env,
    });

  /** In-process worker: a real BullMQ Worker on real Redis, minus the separate process. */
  async function startInProcessWorker(env: Record<string, string> = {}) {
    const w = await startWorker(workerConfig(env), silentLogger);
    workers.push(w);
    return w;
  }

  /** Wait (event-driven) until a job reaches completed or failed; resolves with the fresh job. */
  async function waitForFinished(jobId: string, timeoutMs = 30_000): Promise<Job> {
    const job = await queue.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    await job.waitUntilFinished(events, timeoutMs).catch(() => undefined);
    const fresh = await queue.getJob(jobId);
    if (!fresh) throw new Error(`Job ${jobId} disappeared`);
    const state = await fresh.getState();
    if (state !== 'completed' && state !== 'failed') throw new Error(`Job ${jobId} still ${state} after ${timeoutMs} ms`);
    return fresh;
  }

  /** Wait for a QueueEvents event for a given job. Register *before* triggering the event. */
  function onceJobEvent<T extends Record<string, unknown>>(event: string, jobId: string, timeoutMs: number) {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        events.off(event as 'completed', listener as never);
        reject(new Error(`Timed out after ${timeoutMs} ms waiting for "${event}" on ${jobId}`));
      }, timeoutMs);
      const listener = (args: T) => {
        if (args.jobId !== jobId) return;
        clearTimeout(timer);
        events.off(event as 'completed', listener as never);
        resolve(args);
      };
      events.on(event as 'completed', listener as never);
    });
  }

  async function ready() {
    await Promise.all([queue.waitUntilReady(), events.waitUntilReady()]);
  }

  async function cleanup() {
    await Promise.allSettled(workers.map((w) => w.close()));
    await Promise.allSettled([events.close(), queue.close()]);
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 500);
      cursor = next;
      if (batch.length) await redis.del(...batch);
    } while (cursor !== '0');
    await redis.quit();
  }

  return {
    redisUrl,
    prefix,
    keys,
    redis,
    queue,
    events,
    apiConfig,
    workerConfig,
    startInProcessWorker,
    waitForFinished,
    onceJobEvent,
    ready,
    cleanup,
  };
}

export type TestContext = ReturnType<typeof createTestContext>;
