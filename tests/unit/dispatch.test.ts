import { describe, expect, it } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import type { ExecutionEvent } from '@queueforge/shared';
import { createLogger, metaKeys } from '@queueforge/shared/node';
import { TransientJobError } from '../../apps/worker/src/errors';
import { createJobHandler, type DispatchableJob } from '../../apps/worker/src/handlers/dispatch';
import { createFakeRedis } from '../helpers/fake-redis';

const logger = createLogger({ service: 'test', level: 'silent', pretty: false });

function setup(processors: Parameters<typeof createJobHandler>[0]['processors'] = {}, existing: ExecutionEvent[] = []) {
  const history: ExecutionEvent[] = [...existing];
  const handle = createJobHandler({
    redis: createFakeRedis(),
    keys: metaKeys('unit'),
    workerId: 'w-test',
    logger,
    recordHistory: async (_id, e) => {
      history.push(e);
    },
    loadHistory: async () => [...history],
    processors,
  });
  return { handle, history };
}

function job(overrides: Partial<DispatchableJob> = {}): DispatchableJob {
  return {
    id: 'job_1',
    name: 'failure-simulation',
    data: { durationMs: 0, steps: 1 },
    attemptsMade: 0,
    attemptsStarted: 1,
    opts: { attempts: 3 },
    updateProgress: async () => undefined,
    ...overrides,
  } as DispatchableJob;
}

describe('job dispatch', () => {
  it('routes each job type to its processor with validated, defaulted data', async () => {
    let received: unknown;
    const { handle, history } = setup({
      'report-generation': (async (data: unknown) => {
        received = data;
        return { ok: true };
      }) as never,
    });
    const result = await handle(job({ name: 'report-generation', data: { reportName: 'R', recordCount: 5 } }));
    expect(result).toEqual({ ok: true });
    expect(received).toEqual({ reportName: 'R', recordCount: 5, format: 'json', batchDelayMs: 0 });
    expect(history.map((h) => h.event)).toEqual(['started', 'completed']);
  });

  it('fails unknown job types permanently', async () => {
    const { handle } = setup();
    await expect(handle(job({ name: 'mine-bitcoin' }))).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('fails invalid stored payloads permanently without running the processor', async () => {
    const { handle, history } = setup();
    await expect(handle(job({ data: { durationMs: -5 } }))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ event: 'failed', willRetry: false });
  });

  it('records whether a failed attempt will be retried', async () => {
    const failing = (async () => {
      throw new TransientJobError('flaky');
    }) as never;
    const first = setup({ 'failure-simulation': failing });
    await expect(first.handle(job({ attemptsMade: 0 }))).rejects.toThrow('flaky');
    expect(first.history.at(-1)).toMatchObject({ event: 'failed', willRetry: true });

    const last = setup({ 'failure-simulation': failing });
    await expect(last.handle(job({ attemptsMade: 2, attemptsStarted: 3 }))).rejects.toThrow('flaky');
    expect(last.history.at(-1)).toMatchObject({ event: 'failed', willRetry: false });
  });

  it('records a stall recovery when the previous execution never reported an outcome', async () => {
    const crashed: ExecutionEvent = { event: 'started', workerId: 'w-dead', execution: 1, attemptsMade: 0, at: new Date().toISOString() };
    const { handle, history } = setup({ 'failure-simulation': (async () => ({})) as never }, [crashed]);
    await handle(job({ attemptsStarted: 2 }));
    expect(history.map((h) => h.event)).toEqual(['started', 'stalled-recovered', 'started', 'completed']);
    expect(history[1]!.message).toContain('w-dead');
  });

  it('does not report a stall after an ordinary failed attempt', async () => {
    const failed: ExecutionEvent[] = [
      { event: 'started', workerId: 'w', execution: 1, attemptsMade: 0, at: '' },
      { event: 'failed', workerId: 'w', execution: 1, attemptsMade: 0, at: '', willRetry: true },
    ];
    const { handle, history } = setup({ 'failure-simulation': (async () => ({})) as never }, failed);
    await handle(job({ attemptsStarted: 2, attemptsMade: 1 }));
    expect(history.map((h) => h.event)).not.toContain('stalled-recovered');
  });
});
