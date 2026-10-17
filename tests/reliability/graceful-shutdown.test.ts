import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FailureSimulationResult } from '@queueforge/shared';
import { startWorkerProcess, waitFor, type ManagedProcess } from '../../scripts/lib/harness';
import { createTestContext } from '../helpers/context';

/**
 * SIGTERM must let in-flight jobs finish, stop taking new work, and exit 0.
 *
 * Requires POSIX signals: on Windows, Node's child.kill('SIGTERM') terminates the process
 * forcibly, so there is no graceful path to test. Runs in CI (Linux) and via `npm run test:docker`.
 */
const posix = process.platform !== 'win32';
const t = createTestContext('shutdown');
const procs: ManagedProcess[] = [];

beforeAll(async () => {
  await t.ready();
});

afterAll(async () => {
  for (const p of procs) if (p.isRunning()) p.kill('SIGKILL');
  await Promise.all(procs.map((p) => p.exited));
  await t.cleanup();
});

describe.skipIf(!posix)('graceful worker shutdown (SIGTERM)', () => {
  it('finishes the active job, takes no new work and exits cleanly', async () => {
    const worker = await startWorkerProcess({
      redisUrl: t.redisUrl,
      prefix: t.prefix,
      workerId: 'graceful-1',
      concurrency: 1,
      shutdownTimeoutMs: 20_000,
    });
    procs.push(worker);

    const job = await t.queue.add('failure-simulation', { durationMs: 3_000, steps: 6 }, { attempts: 3 });
    await t.onceJobEvent('progress', job.id!, 20_000);

    worker.kill('SIGTERM');
    await worker.waitForLog((l) => l.json?.event === 'worker.shutting_down', 5_000, 'worker.shutting_down');

    // Submitted after shutdown began: must not be picked up by the closing worker.
    const late = await t.queue.add('failure-simulation', { durationMs: 10, steps: 1 }, { attempts: 3 });

    const exit = await worker.exited;
    expect(exit).toEqual({ code: 0, signal: null });

    const finished = (await t.queue.getJob(job.id!))!;
    expect(await finished.getState()).toBe('completed');
    expect((finished.returnvalue as FailureSimulationResult).completedBy).toBe('graceful-1');
    expect(finished.stalledCounter).toBe(0); // completed normally, not via stall recovery
    expect(await (await t.queue.getJob(late.id!))!.getState()).toBe('waiting');

    // Heartbeat removed on clean shutdown.
    await waitFor(async () => !(await t.redis.exists(t.keys.heartbeat('graceful-1'))), { timeoutMs: 2_000 });
  });
});
