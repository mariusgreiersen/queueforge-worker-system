import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readHistory } from '@queueforge/shared/node';
import { startWorkerProcess, type ManagedProcess } from '../../scripts/lib/harness';
import { createTestContext } from '../helpers/context';

/**
 * A job that keeps crashing its workers must not be recovered forever. With maxStalledCount = 0,
 * BullMQ fails the job on its first stall instead of recovering it. (BullMQ 6 implements this as a
 * deferred failure: the job is marked and returned to wait, and the next worker that fetches it fails
 * it immediately without running the processor.)
 */
const t = createTestContext('stall-limit');
const procs: ManagedProcess[] = [];

beforeAll(async () => {
  await t.ready();
});

afterAll(async () => {
  for (const p of procs) if (p.isRunning()) p.kill('SIGKILL');
  await Promise.all(procs.map((p) => p.exited));
  await t.cleanup();
});

describe('stalled recovery limit', () => {
  it('fails a job that stalls more than maxStalledCount times instead of looping', async () => {
    const opts = { redisUrl: t.redisUrl, prefix: t.prefix, lockDurationMs: 3_000, stalledIntervalMs: 1_500, maxStalledCount: 0 };
    const victim = await startWorkerProcess({ ...opts, workerId: 'limit-victim' });
    procs.push(victim);

    const job = await t.queue.add('failure-simulation', { durationMs: 20_000, steps: 20 }, { attempts: 3 });
    // First progress update: the processor is really executing on the victim.
    await t.onceJobEvent('progress', job.id!, 20_000);
    expect((await t.queue.getJob(job.id!))!.processedBy).toBe('limit-victim');

    victim.kill('SIGKILL');
    await victim.exited;

    const failed = t.onceJobEvent<{ failedReason: string }>('failed', job.id!, 30_000);
    const survivor = await startWorkerProcess({ ...opts, workerId: 'limit-survivor' });
    procs.push(survivor);

    const { failedReason } = await failed;
    expect(failedReason).toMatch(/stalled more than allowable limit/);
    const fresh = (await t.queue.getJob(job.id!))!;
    expect(await fresh.getState()).toBe('failed');
    // The processor ran exactly once (on the victim); the survivor never executed it.
    const starts = (await readHistory(t.redis, t.keys, job.id!)).filter((e) => e.event === 'started');
    expect(starts.map((e) => e.workerId)).toEqual(['limit-victim']);
  });
});
