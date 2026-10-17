import { describe, expect, it, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { dataTransformationDataSchema, failureSimulationDataSchema, reportGenerationDataSchema } from '@queueforge/shared';
import { createLogger, metaKeys } from '@queueforge/shared/node';
import { classifyError, PermanentJobError, TransientJobError } from '../../apps/worker/src/errors';
import type { ProcessorContext } from '../../apps/worker/src/processors/context';
import { failureSimulation } from '../../apps/worker/src/processors/failure-simulation';
import { renderCsv, reportGeneration, reportIdFor } from '../../apps/worker/src/processors/report-generation';
import { computeAggregate, runTransformations } from '../../apps/worker/src/processors/data-transformation';
import { createFakeRedis } from '../helpers/fake-redis';

const logger = createLogger({ service: 'test', level: 'silent', pretty: false });

function ctx(overrides: Partial<ProcessorContext> = {}) {
  const redis = createFakeRedis();
  const progress: number[] = [];
  const context: ProcessorContext = {
    jobId: 'job_test',
    workerId: 'worker-test',
    execution: 1,
    attemptsMade: 0,
    maxAttempts: 3,
    reportProgress: async (p) => {
      progress.push(p);
    },
    redis,
    keys: metaKeys('unit'),
    logger,
    ...overrides,
  };
  return { context, redis, progress };
}

describe('error classification', () => {
  it('treats UnrecoverableError (and subclasses) as permanent, everything else as transient', () => {
    expect(classifyError(new PermanentJobError('bad input'))).toBe('permanent');
    expect(classifyError(new UnrecoverableError('x'))).toBe('permanent');
    expect(classifyError(new TransientJobError('timeout'))).toBe('transient');
    expect(classifyError(new Error('unknown'))).toBe('transient');
    expect(classifyError('string thrown')).toBe('transient');
    expect(new PermanentJobError('x')).toBeInstanceOf(UnrecoverableError);
  });
});

describe('report-generation processor', () => {
  const data = reportGenerationDataSchema.parse({ reportName: 'Monthly Sales Report', recordCount: 1234 });

  it('processes every record in batches and reports monotonic progress up to 100', async () => {
    const { context, progress } = ctx();
    const result = await reportGeneration(data, context);
    expect(result.recordsProcessed).toBe(1234);
    expect(result.batches).toBe(3);
    expect(progress.at(-1)).toBe(100);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    const regionOrders = Object.values(result.summary.byRegion).reduce((n, r) => n + r.orders, 0);
    expect(regionOrders).toBe(1234);
    expect(result.summary.minOrderValue).toBeLessThanOrEqual(result.summary.averageOrderValue);
    expect(result.summary.maxOrderValue).toBeGreaterThanOrEqual(result.summary.averageOrderValue);
    expect(result.summary.topProducts).toHaveLength(5);
  });

  it('is deterministic for the same input', async () => {
    const a = await reportGeneration(data, ctx().context);
    const b = await reportGeneration(data, ctx({ jobId: 'job_other' }).context);
    expect(a.summary).toEqual(b.summary);
    const c = await reportGeneration({ ...data, reportName: 'Another report' }, ctx().context);
    expect(c.summary).not.toEqual(a.summary);
  });

  it('derives a stable report id from the job id and stores the report once', async () => {
    const { context, redis } = ctx();
    const first = await reportGeneration(data, context);
    const second = await reportGeneration(data, context); // re-execution of the same job
    expect(first.reportId).toBe(reportIdFor('job_test'));
    expect(second.reportId).toBe(first.reportId);
    expect(first.stored.created).toBe(true);
    expect(second.stored.created).toBe(false);
    expect(await redis.llen(metaKeys('unit').sideEffectLog('job_test'))).toBe(1);
  });

  it('renders CSV output when requested', async () => {
    const result = await reportGeneration({ ...data, format: 'csv' }, ctx().context);
    expect(result.output?.split('\n')[0]).toBe('region,orders,revenue');
    expect(renderCsv({ EMEA: { orders: 2, revenue: 10 } })).toBe('region,orders,revenue\nEMEA,2,10.00');
  });
});

describe('data-transformation processor', () => {
  const records = [
    { name: '  Alice ', team: 'core', score: 10, active: true },
    { name: 'Bob', team: 'core', score: 30, active: false },
    { name: 'Carol', team: 'infra', score: 20, active: true },
    { name: 'Bob', team: 'core', score: 30, active: false },
    { name: 'Dan', team: 'infra', score: null, active: true },
  ];

  it('runs the pipeline in order and records per-step metadata', async () => {
    const data = dataTransformationDataSchema.parse({
      records,
      operations: [
        { op: 'dedupe' },
        { op: 'normalize', fields: ['name'], mode: 'trim' },
        { op: 'filter', field: 'active', operator: 'eq', value: true },
        { op: 'group', by: ['team'], aggregates: [{ fn: 'count' }, { fn: 'avg', field: 'score', as: 'avgScore' }] },
        { op: 'sort', field: 'team' },
      ],
    });
    const result = await runTransformations(data);
    expect(result.steps.map((s) => [s.op, s.inputCount, s.outputCount])).toEqual([
      ['dedupe', 5, 4],
      ['normalize', 4, 4],
      ['filter', 4, 3],
      ['group', 3, 2],
      ['sort', 2, 2],
    ]);
    expect(result.records).toEqual([
      { team: 'core', count: 1, avgScore: 10 },
      { team: 'infra', count: 2, avgScore: 20 },
    ]);
  });

  it('supports comparison filters, min-max normalisation and dataset aggregates', async () => {
    const data = dataTransformationDataSchema.parse({
      records,
      operations: [
        { op: 'filter', field: 'score', operator: 'gte', value: 20 },
        { op: 'normalize', fields: ['score'], mode: 'min-max' },
        { op: 'aggregate', aggregates: [{ fn: 'sum', field: 'score' }, { fn: 'max', field: 'score' }, { fn: 'count' }] },
      ],
    });
    const result = await runTransformations(data);
    expect(result.records.map((r) => r.score)).toEqual([1, 0, 1]);
    expect(result.aggregates).toEqual({ sum_score: 2, max_score: 1, count: 3 });
  });

  it('dedupes on selected fields and filters with "in"', async () => {
    const data = dataTransformationDataSchema.parse({
      records,
      operations: [
        { op: 'dedupe', fields: ['team'] },
        { op: 'filter', field: 'name', operator: 'in', value: ['Carol', '  Alice '] },
      ],
    });
    const result = await runTransformations(data);
    expect(result.records.map((r) => r.name)).toEqual(['  Alice ', 'Carol']);
  });

  it('fails permanently on min-max over non-numeric values', async () => {
    const data = dataTransformationDataSchema.parse({ records, operations: [{ op: 'normalize', fields: ['name'], mode: 'min-max' }] });
    await expect(runTransformations(data)).rejects.toBeInstanceOf(PermanentJobError);
  });

  it('computes aggregates ignoring nulls', () => {
    expect(computeAggregate(records, { fn: 'avg', field: 'score' })).toBe(22.5);
    expect(computeAggregate(records, { fn: 'count', field: 'score' })).toBe(4);
    expect(computeAggregate([], { fn: 'min', field: 'score' })).toBeNull();
  });

  it('is deterministic (safe to re-execute)', async () => {
    const data = dataTransformationDataSchema.parse({ records, operations: [{ op: 'sort', field: 'score', direction: 'desc' }] });
    expect(await runTransformations(data)).toMatchObject({ records: (await runTransformations(data)).records });
  });
});

describe('failure-simulation processor', () => {
  it('fails the first N attempts deterministically with a transient error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const data = failureSimulationDataSchema.parse({ durationMs: 100, steps: 2, failFirstAttempts: 2 });
      for (const attemptsMade of [0, 1]) {
        const run = failureSimulation(data, ctx({ attemptsMade }).context);
        const assertion = expect(run).rejects.toBeInstanceOf(TransientJobError);
        await vi.runAllTimersAsync();
        await assertion;
      }
      const ok = failureSimulation(data, ctx({ attemptsMade: 2, execution: 3 }).context);
      await vi.runAllTimersAsync();
      await expect(ok).resolves.toMatchObject({ previousFailures: 2, execution: 3, completedBy: 'worker-test' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('raises a permanent error in permanent mode', async () => {
    const data = failureSimulationDataSchema.parse({ durationMs: 0, steps: 1, failFirstAttempts: 1, failureMode: 'permanent' });
    await expect(failureSimulation(data, ctx().context)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('performs its side effect at most once across re-executions', async () => {
    const data = failureSimulationDataSchema.parse({ durationMs: 0, steps: 1 });
    const { context, redis } = ctx();
    const first = await failureSimulation(data, context);
    const second = await failureSimulation(data, { ...context, execution: 2 });
    expect(first.sideEffect.created).toBe(true);
    expect(second.sideEffect.created).toBe(false);
    expect(await redis.llen(metaKeys('unit').sideEffectLog('job_test'))).toBe(1);
  });
});
