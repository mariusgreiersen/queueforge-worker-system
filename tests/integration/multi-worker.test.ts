import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FailureSimulationResult } from '@queueforge/shared';
import { startWorkerProcess, type ManagedProcess } from '../../scripts/lib/harness';
import { createTestContext } from '../helpers/context';

const t = createTestContext('multi');
const procs: ManagedProcess[] = [];

beforeAll(async () => {
  await t.ready();
});

afterAll(async () => {
  for (const p of procs) if (p.isRunning()) p.kill('SIGKILL');
  await Promise.all(procs.map((p) => p.exited));
  await t.cleanup();
});

describe('multiple independent worker processes', () => {
  it('distributes queued jobs across workers and completes all of them', async () => {
    const [a, b] = await Promise.all([
      startWorkerProcess({ redisUrl: t.redisUrl, prefix: t.prefix, workerId: 'proc-a', concurrency: 2 }),
      startWorkerProcess({ redisUrl: t.redisUrl, prefix: t.prefix, workerId: 'proc-b', concurrency: 2 }),
    ]);
    procs.push(a, b);

    const jobs = await t.queue.addBulk(
      Array.from({ length: 16 }, (_, i) => ({
        name: 'failure-simulation',
        data: { durationMs: 300, steps: 2, label: `bulk-${i}` },
        opts: { attempts: 3 },
      })),
    );
    const finished = await Promise.all(jobs.map((j) => t.waitForFinished(j.id!, 30_000)));

    expect(await Promise.all(finished.map((j) => j.getState()))).toEqual(Array(16).fill('completed'));
    const byWorker = new Map<string, number>();
    for (const j of finished) {
      const w = (j.returnvalue as FailureSimulationResult).completedBy;
      byWorker.set(w, (byWorker.get(w) ?? 0) + 1);
      expect(j.processedBy).toBe(w);
    }
    // Both processes took part. (Exact split depends on timing, so only presence is asserted.)
    expect([...byWorker.keys()].sort()).toEqual(['proc-a', 'proc-b']);
  });
});
