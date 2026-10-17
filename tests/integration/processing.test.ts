import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataTransformationResult, ExecutionEvent, ReportGenerationResult, SubmitJobInput } from '@queueforge/shared';
import { readHistory } from '@queueforge/shared/node';
import { createQueueClients, type QueueClients } from '../../apps/api/src/queue';
import { JobService } from '../../apps/api/src/services/job-service';
import { createTestContext, silentLogger } from '../helpers/context';

const t = createTestContext('processing');
let clients: QueueClients;
let service: JobService;

const submit = (input: unknown) => service.submit(input as SubmitJobInput);

beforeAll(async () => {
  await t.ready();
  const config = t.apiConfig();
  clients = createQueueClients(config, silentLogger);
  service = new JobService(clients, config);
  await t.startInProcessWorker({ WORKER_CONCURRENCY: '4' });
});

afterAll(async () => {
  await clients.close();
  await t.cleanup();
});

/** Gaps between each failed attempt and the start of the next attempt, from the worker-recorded history. */
function backoffGaps(history: ExecutionEvent[]): number[] {
  const gaps: number[] = [];
  history.forEach((e, i) => {
    if (e.event !== 'failed') return;
    const next = history.slice(i + 1).find((n) => n.event === 'started');
    if (next) gaps.push(Date.parse(next.at) - Date.parse(e.at));
  });
  return gaps;
}

describe('job processing on real Redis', () => {
  it('processes a report-generation job and stores a real result', async () => {
    const { jobId } = await submit({ type: 'report-generation', data: { reportName: 'Integration', recordCount: 5000 } });
    const job = await t.waitForFinished(jobId);
    expect(await job.getState()).toBe('completed');
    const result = job.returnvalue as ReportGenerationResult;
    expect(result.recordsProcessed).toBe(5000);
    expect(result.batches).toBe(10);
    expect(result.stored.created).toBe(true);
    // The stored report artifact exists in Redis under the deterministic report id.
    const stored = JSON.parse((await t.redis.get(t.keys.report(result.reportId)))!);
    expect(stored.summary).toEqual(result.summary);

    const detail = await service.get(jobId);
    expect(detail).toMatchObject({ state: 'completed', progress: 100, attemptsMade: 1, attemptsStarted: 1 });
    expect(detail.startedAt).not.toBeNull();
    expect(detail.durationMs).toBeGreaterThanOrEqual(0);
    expect(detail.history.map((h) => h.event)).toEqual(['started', 'completed']);
  });

  it('processes a data-transformation job', async () => {
    const { jobId } = await submit({
      type: 'data-transformation',
      data: {
        records: [
          { city: 'Copenhagen', temp: 12 },
          { city: 'copenhagen ', temp: 14 },
          { city: 'Aarhus', temp: 10 },
        ],
        operations: [
          { op: 'normalize', fields: ['city'], mode: 'trim' },
          { op: 'normalize', fields: ['city'], mode: 'lowercase' },
          { op: 'group', by: ['city'], aggregates: [{ fn: 'avg', field: 'temp', as: 'avgTemp' }, { fn: 'count' }] },
          { op: 'sort', field: 'city' },
        ],
      },
    });
    const job = await t.waitForFinished(jobId);
    const result = job.returnvalue as DataTransformationResult;
    expect(result.records).toEqual([
      { city: 'aarhus', avgTemp: 10, count: 1 },
      { city: 'copenhagen', avgTemp: 13, count: 2 },
    ]);
    expect(result.steps).toHaveLength(4);
  });

  it('reports progress updates while a job runs', async () => {
    const { jobId } = await submit({ type: 'failure-simulation', data: { durationMs: 600, steps: 4 } });
    const seen: number[] = [];
    const listener = ({ jobId: id, data }: { jobId: string; data: unknown }) => {
      if (id === jobId && typeof data === 'number') seen.push(data);
    };
    t.events.on('progress', listener);
    await t.waitForFinished(jobId);
    t.events.off('progress', listener);
    expect(seen).toEqual([25, 50, 75, 100]);
  });

  it('fails twice, then succeeds on the third attempt using the default 1s/2s exponential backoff', async () => {
    const { jobId } = await submit({ type: 'failure-simulation', data: { durationMs: 50, steps: 1, failFirstAttempts: 2 } });
    const job = await t.waitForFinished(jobId, 20_000);
    expect(await job.getState()).toBe('completed');
    expect(job.attemptsMade).toBe(3); // BullMQ counts the successful attempt too
    expect(job.stacktrace).toHaveLength(2);

    const history = await readHistory(t.redis, t.keys, jobId);
    expect(history.map((h) => `${h.event}${h.willRetry === undefined ? '' : `:${h.willRetry}`}`)).toEqual([
      'started',
      'failed:true',
      'started',
      'failed:true',
      'started',
      'completed',
    ]);
    const [first, second] = backoffGaps(history);
    // Backoff delays are 1000 ms then 2000 ms; allow a little clock/scheduling slack below.
    expect(first).toBeGreaterThanOrEqual(950);
    expect(second).toBeGreaterThanOrEqual(1950);
    expect(second!).toBeGreaterThan(first!);
    expect(second).toBeLessThan(6_000);
  });

  it('marks a job awaiting retry while it is delayed by backoff', async () => {
    const { jobId } = await submit({
      type: 'failure-simulation',
      data: { durationMs: 10, steps: 1, failFirstAttempts: 1 },
      options: { backoffDelayMs: 3000 },
    });
    const delayed = await t.onceJobEvent('delayed', jobId, 10_000);
    expect(delayed).toBeTruthy();
    const detail = await service.get(jobId);
    expect(detail).toMatchObject({ state: 'delayed', awaitingRetry: true, attemptsMade: 1, maxAttempts: 3 });
    expect(detail.failedReason).toMatch(/Simulated transient failure on attempt 1/);
    await t.waitForFinished(jobId, 15_000);
  });

  it('stays failed after exhausting all attempts', async () => {
    const { jobId } = await submit({
      type: 'failure-simulation',
      data: { durationMs: 10, steps: 1, failFirstAttempts: 10 },
      options: { attempts: 3, backoffDelayMs: 100 },
    });
    const exhausted = t.onceJobEvent('retries-exhausted', jobId, 15_000);
    const job = await t.waitForFinished(jobId, 15_000);
    await exhausted;
    expect(await job.getState()).toBe('failed');
    expect(job.attemptsMade).toBe(3);
    const detail = await service.get(jobId);
    expect(detail).toMatchObject({ state: 'failed', awaitingRetry: false, attemptsMade: 3, maxAttempts: 3 });
    expect(detail.attemptErrors).toHaveLength(3);
    const gaps = backoffGaps(detail.history);
    expect(gaps[0]).toBeGreaterThanOrEqual(90);
    expect(gaps[1]).toBeGreaterThanOrEqual(190);

    // Still failed a moment later: nothing re-queues it automatically.
    await new Promise((r) => setTimeout(r, 500));
    expect(await (await t.queue.getJob(jobId))!.getState()).toBe('failed');
  });

  it('fails permanent errors immediately without consuming retries', async () => {
    const { jobId } = await submit({
      type: 'failure-simulation',
      data: { durationMs: 10, steps: 1, failFirstAttempts: 1, failureMode: 'permanent' },
    });
    const job = await t.waitForFinished(jobId);
    expect(await job.getState()).toBe('failed');
    expect(job.attemptsMade).toBe(1);
    expect(job.failedReason).toMatch(/permanent failure/);
  });

  it('fails invalid stored payloads permanently (worker-side validation)', async () => {
    // Bypass the API to simulate corrupted or hand-crafted data in Redis.
    const job = await t.queue.add('report-generation', { reportName: '', recordCount: -3 }, { attempts: 3 });
    const done = await t.waitForFinished(job.id!);
    expect(await done.getState()).toBe('failed');
    expect(done.attemptsMade).toBe(1);
    expect(done.failedReason).toMatch(/Invalid job data/);
  });
});
