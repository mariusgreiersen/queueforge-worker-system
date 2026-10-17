import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FailureSimulationResult, SubmitJobInput } from '@queueforge/shared';
import { countSideEffects, readHistory } from '@queueforge/shared/node';
import { repoRoot, startWorkerProcess, waitFor, type ManagedProcess } from '../../scripts/lib/harness';
import { createQueueClients, type QueueClients } from '../../apps/api/src/queue';
import { JobService } from '../../apps/api/src/services/job-service';
import { createTestContext, silentLogger } from '../helpers/context';

/**
 * FLAGSHIP RELIABILITY TEST
 *
 * Two independent worker processes. A long-running job starts on one of them; that process is
 * killed abruptly (SIGKILL: no shutdown hooks, no lock release). BullMQ's own stalled-job
 * detection on the surviving worker must notice the expired lock and return the job to the queue,
 * and the survivor must complete it under the same job id with one persistent side effect.
 */
const LOCK_DURATION_MS = 4_000;
const STALLED_INTERVAL_MS = 2_000;
const JOB_DURATION_MS = 8_000;

const t = createTestContext('crash');
let clients: QueueClients;
let service: JobService;
const workers = new Map<string, ManagedProcess>();

beforeAll(async () => {
  await t.ready();
  const config = t.apiConfig();
  clients = createQueueClients(config, silentLogger);
  service = new JobService(clients, config);
  const common = {
    redisUrl: t.redisUrl,
    prefix: t.prefix,
    concurrency: 2,
    lockDurationMs: LOCK_DURATION_MS,
    stalledIntervalMs: STALLED_INTERVAL_MS,
    maxStalledCount: 1,
  };
  const [a, b] = await Promise.all([
    startWorkerProcess({ ...common, workerId: 'worker-a' }),
    startWorkerProcess({ ...common, workerId: 'worker-b' }),
  ]);
  workers.set('worker-a', a).set('worker-b', b);
});

afterAll(async () => {
  for (const p of workers.values()) if (p.isRunning()) p.kill('SIGKILL');
  await Promise.all([...workers.values()].map((p) => p.exited));
  await clients.close();
  await t.cleanup();
});

describe('worker crash recovery (real process kill)', () => {
  it('recovers a job whose worker was SIGKILLed mid-execution', async () => {
    const activeAt = new Map<string, number>();
    t.events.on('active', ({ jobId }) => activeAt.set(jobId, Date.now()));

    const { jobId } = await service.submit({
      type: 'failure-simulation',
      data: { durationMs: JOB_DURATION_MS, steps: 16, label: 'crash-recovery-test' },
    } as SubmitJobInput);

    // 1. Wait until a worker has actually started executing it (first progress update).
    const progressed = t.onceJobEvent('progress', jobId, 20_000);
    await waitFor(async () => activeAt.has(jobId), { timeoutMs: 20_000, description: 'job to become active' });
    await progressed;
    const owner = (await t.queue.getJob(jobId))!.processedBy!;
    const victim = workers.get(owner)!;
    const survivorId = [...workers.keys()].find((id) => id !== owner)!;
    expect(victim).toBeDefined();
    expect(await (await t.queue.getJob(jobId))!.getState()).toBe('active');

    // 2. Kill the owning worker abruptly. Listeners are registered before the kill.
    const stalled = t.onceJobEvent('stalled', jobId, 30_000);
    const completed = t.onceJobEvent('completed', jobId, 60_000);
    const killedAt = Date.now();
    victim.kill('SIGKILL');
    const exit = await victim.exited;
    expect(exit.code === 0 && exit.signal === null).toBe(false); // it did not exit cleanly
    expect(workers.get(survivorId)!.isRunning()).toBe(true);

    // 3. The job is still "active" in Redis right after the crash: nothing has noticed yet.
    expect(await (await t.queue.getJob(jobId))!.getState()).toBe('active');

    // 4. BullMQ's stalled checker (running in the survivor) detects the expired lock.
    await stalled;
    const stalledAt = Date.now();

    // 5. The survivor picks the job up again and completes it.
    await completed;
    const completedAt = Date.now();

    const job = (await t.queue.getJob(jobId))!;
    const result = job.returnvalue as FailureSimulationResult;
    expect(job.id).toBe(jobId); // same job, not a resubmission
    expect(await job.getState()).toBe('completed');
    expect(job.processedBy).toBe(survivorId);
    expect(job.stalledCounter).toBe(1);
    expect(job.attemptsStarted).toBe(2);
    expect(job.attemptsMade).toBe(1); // stall recovery does not consume a retry attempt

    expect(result).toMatchObject({ label: 'crash-recovery-test', completedBy: survivorId, execution: 2, previousFailures: 0, steps: 16 });
    expect(result.durationMs).toBeGreaterThanOrEqual(JOB_DURATION_MS * 0.95);
    expect(result.sideEffect.created).toBe(true);

    // Exactly one persistent side effect despite two executions.
    expect(await countSideEffects(t.redis, t.keys, jobId)).toBe(1);

    const history = await readHistory(t.redis, t.keys, jobId);
    expect(history.map((h) => `${h.event}@${h.workerId}`)).toEqual([
      `started@${owner}`,
      `stalled-recovered@${survivorId}`,
      `started@${survivorId}`,
      `completed@${survivorId}`,
    ]);

    // Detection is bounded by lock expiry plus up to two stalled-check cycles (+ scheduling slack).
    const detectionMs = stalledAt - killedAt;
    const recoveryMs = completedAt - killedAt;
    expect(detectionMs).toBeLessThanOrEqual(LOCK_DURATION_MS + 2 * STALLED_INTERVAL_MS + 2_000);

    const observed = {
      test: 'crash-recovery',
      recordedAt: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      lockDurationMs: LOCK_DURATION_MS,
      stalledIntervalMs: STALLED_INTERVAL_MS,
      jobDurationMs: JOB_DURATION_MS,
      killedWorker: owner,
      recoveredBy: survivorId,
      killToStalledDetectedMs: detectionMs,
      killToCompletedMs: recoveryMs,
    };
    const dir = resolve(repoRoot, 'tests/.results');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'crash-recovery.json'), JSON.stringify(observed, null, 2));
    console.log(`[crash-recovery] observed: ${JSON.stringify(observed)}`);
  });
});
