import { describe, expect, it } from 'vitest';
import { LIMITS, batchSubmitSchema, jobOptionsSchema, listJobsQuerySchema, submitJobSchema } from '@queueforge/shared';

describe('submitJobSchema', () => {
  it('accepts the documented report-generation example and applies defaults', () => {
    const parsed = submitJobSchema.parse({
      type: 'report-generation',
      data: { reportName: 'Monthly Sales Report', recordCount: 1000, format: 'json' },
      options: { priority: 2, deduplicationKey: 'monthly-sales-report' },
    });
    expect(parsed.type).toBe('report-generation');
    if (parsed.type === 'report-generation') expect(parsed.data.batchDelayMs).toBe(0);
  });

  it('applies failure-simulation defaults', () => {
    const parsed = submitJobSchema.parse({ type: 'failure-simulation', data: {} });
    expect(parsed.data).toEqual({ durationMs: 5000, steps: 10, failFirstAttempts: 0, failureMode: 'transient' });
  });

  it.each([
    ['unknown job type', { type: 'shell-command', data: { cmd: 'rm -rf /' } }],
    ['record count above limit', { type: 'report-generation', data: { reportName: 'x', recordCount: LIMITS.report.maxRecords + 1 } }],
    ['non-integer record count', { type: 'report-generation', data: { reportName: 'x', recordCount: 1.5 } }],
    ['empty report name', { type: 'report-generation', data: { reportName: '   ', recordCount: 10 } }],
    ['unknown data field (strict)', { type: 'report-generation', data: { reportName: 'x', recordCount: 10, script: 'alert(1)' } }],
    ['unknown envelope field (strict)', { type: 'failure-simulation', data: {}, extra: true }],
    ['simulation duration above limit', { type: 'failure-simulation', data: { durationMs: 10_000_000 } }],
    ['empty dataset', { type: 'data-transformation', data: { records: [], operations: [{ op: 'dedupe' }] } }],
    [
      'nested object values in records',
      { type: 'data-transformation', data: { records: [{ a: { b: 1 } }], operations: [{ op: 'dedupe' }] } },
    ],
    [
      'aggregate other than count without field',
      { type: 'data-transformation', data: { records: [{ a: 1 }], operations: [{ op: 'aggregate', aggregates: [{ fn: 'sum' }] }] } },
    ],
    ['unknown operation', { type: 'data-transformation', data: { records: [{ a: 1 }], operations: [{ op: 'eval', code: '1' }] } }],
  ])('rejects %s', (_name, payload) => {
    expect(submitJobSchema.safeParse(payload).success).toBe(false);
  });

  it('bounds the transformation dataset size', () => {
    const records = Array.from({ length: LIMITS.transformation.maxRecords + 1 }, (_, i) => ({ i }));
    const result = submitJobSchema.safeParse({ type: 'data-transformation', data: { records, operations: [{ op: 'dedupe' }] } });
    expect(result.success).toBe(false);
  });
});

describe('jobOptionsSchema', () => {
  it('enforces server-defined retry limits', () => {
    expect(jobOptionsSchema.safeParse({ attempts: 5, backoffDelayMs: 100 }).success).toBe(true);
    expect(jobOptionsSchema.safeParse({ attempts: 6 }).success).toBe(false);
    expect(jobOptionsSchema.safeParse({ attempts: 0 }).success).toBe(false);
    expect(jobOptionsSchema.safeParse({ backoffDelayMs: 50 }).success).toBe(false);
    expect(jobOptionsSchema.safeParse({ backoffDelayMs: 60_000 }).success).toBe(false);
  });

  it('restricts deduplication keys to a safe character set', () => {
    expect(jobOptionsSchema.safeParse({ deduplicationKey: 'monthly-sales:2026.10' }).success).toBe(true);
    expect(jobOptionsSchema.safeParse({ deduplicationKey: 'has space' }).success).toBe(false);
    expect(jobOptionsSchema.safeParse({ deduplicationKey: 'x'.repeat(129) }).success).toBe(false);
  });

  it('restricts priority to 1-10', () => {
    expect(jobOptionsSchema.safeParse({ priority: 1 }).success).toBe(true);
    expect(jobOptionsSchema.safeParse({ priority: 11 }).success).toBe(false);
  });
});

describe('batchSubmitSchema', () => {
  it('caps batch size', () => {
    const job = { type: 'failure-simulation', data: {} };
    expect(batchSubmitSchema.safeParse({ jobs: Array(LIMITS.batchSubmit.maxJobs).fill(job) }).success).toBe(true);
    expect(batchSubmitSchema.safeParse({ jobs: Array(LIMITS.batchSubmit.maxJobs + 1).fill(job) }).success).toBe(false);
  });
});

describe('listJobsQuerySchema', () => {
  it('coerces query-string numbers and applies defaults', () => {
    expect(listJobsQuerySchema.parse({ page: '2', pageSize: '50' })).toMatchObject({ page: 2, pageSize: 50, state: 'all', sort: 'newest' });
    expect(listJobsQuerySchema.safeParse({ pageSize: '500' }).success).toBe(false);
    expect(listJobsQuerySchema.safeParse({ state: 'exploded' }).success).toBe(false);
  });
});
