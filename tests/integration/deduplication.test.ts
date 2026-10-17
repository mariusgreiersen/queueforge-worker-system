import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FailureSimulationResult, SubmitJobInput } from '@queueforge/shared';
import { countSideEffects } from '@queueforge/shared/node';
import { createQueueClients, type QueueClients } from '../../apps/api/src/queue';
import { JobService } from '../../apps/api/src/services/job-service';
import { createTestContext, silentLogger } from '../helpers/context';

const t = createTestContext('dedup');
let clients: QueueClients;
let service: JobService;

const sim = (key: string, durationMs = 2000): SubmitJobInput =>
  ({ type: 'failure-simulation', data: { durationMs, steps: 4 }, options: { deduplicationKey: key } }) as SubmitJobInput;

beforeAll(async () => {
  await t.ready();
  const config = t.apiConfig();
  clients = createQueueClients(config, silentLogger);
  service = new JobService(clients, config);
});

afterAll(async () => {
  await clients.close();
  await t.cleanup();
});

describe('deduplication (BullMQ Simple Mode)', () => {
  it('accepts a normal submission', async () => {
    const res = await service.submit(sim('normal'));
    expect(res).toMatchObject({ deduplicated: false, status: 'waiting', deduplicationId: 'failure-simulation:normal' });
  });

  it('suppresses a duplicate while the original is waiting', async () => {
    const a = await service.submit(sim('while-waiting'));
    const b = await service.submit(sim('while-waiting'));
    expect(b).toMatchObject({ jobId: a.jobId, deduplicated: true });
    expect(await t.queue.getJobCountByTypes('waiting')).toBe(2); // 'normal' + 'while-waiting', not 3
  });

  it('scopes keys by job type', async () => {
    const report = await service.submit({
      type: 'report-generation',
      data: { reportName: 'x', recordCount: 10, format: 'json', batchDelayMs: 0 },
      options: { deduplicationKey: 'while-waiting' },
    });
    expect(report.deduplicated).toBe(false);
  });

  it('suppresses a duplicate while the original is active, then allows a new job after completion', async () => {
    const original = await service.submit(sim('while-active', 1500));
    const active = t.onceJobEvent('active', original.jobId, 15_000);
    const worker = await t.startInProcessWorker({ WORKER_CONCURRENCY: '5' });
    await active;

    const dup = await service.submit(sim('while-active', 1500));
    expect(dup).toMatchObject({ jobId: original.jobId, deduplicated: true, status: 'active' });

    await t.waitForFinished(original.jobId);
    const after = await service.submit(sim('while-active', 10));
    expect(after.deduplicated).toBe(false);
    expect(after.jobId).not.toBe(original.jobId);
    await t.waitForFinished(after.jobId);
    await worker.close();
  });

  it('releases the key when a pending job is cancelled', async () => {
    const a = await service.submit(sim('cancel-release'));
    await service.cancel(a.jobId);
    const b = await service.submit(sim('cancel-release'));
    expect(b.deduplicated).toBe(false);
  });
});

describe('idempotent re-execution', () => {
  it('re-processing the same job does not duplicate its persistent side effect', async () => {
    const worker = await t.startInProcessWorker();
    const { jobId } = await service.submit({ type: 'failure-simulation', data: { durationMs: 50, steps: 1 } } as SubmitJobInput);
    const first = await t.waitForFinished(jobId);
    expect((first.returnvalue as FailureSimulationResult).sideEffect.created).toBe(true);

    // Force a second execution of the *same* job id (what a crash after the side effect would cause).
    await first.retry('completed');
    const second = await t.waitForFinished(jobId);
    const result = second.returnvalue as FailureSimulationResult;
    expect(second.attemptsStarted).toBe(2);
    expect(result.execution).toBe(2);
    expect(result.sideEffect.created).toBe(false);
    expect(await countSideEffects(t.redis, t.keys, jobId)).toBe(1);
    await worker.close();
  });
});
