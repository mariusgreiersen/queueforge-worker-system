import { describe, expect, it } from 'vitest';
import { firstLine, normalizeProgress, normalizeState, toJobDetail, toJobSummary } from '../../apps/api/src/services/job-mapper';
import { compareStreamIds } from '../../apps/api/src/services/event-hub';
import { deduplicationIdFor, newJobId } from '../../apps/api/src/services/job-service';

const base = {
  id: 'job_1',
  name: 'failure-simulation',
  data: { durationMs: 10 },
  opts: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
  progress: 40,
  attemptsMade: 0,
  attemptsStarted: 0,
  stalledCounter: 0,
  priority: 0,
  timestamp: Date.parse('2026-01-01T00:00:00.000Z'),
  processedOn: undefined as number | undefined,
  finishedOn: undefined as number | undefined,
  failedReason: '',
  returnvalue: null as unknown,
  stacktrace: [] as string[],
  deduplicationId: undefined as string | undefined,
  processedBy: undefined as string | undefined,
};
type MappableJob = Parameters<typeof toJobSummary>[0];
const job = (o: Partial<typeof base> = {}) => ({ ...base, ...o }) as unknown as MappableJob;

describe('job mapping', () => {
  it('maps a waiting job', () => {
    expect(toJobSummary(job(), 'waiting')).toMatchObject({
      state: 'waiting',
      progress: 40,
      maxAttempts: 3,
      startedAt: null,
      durationMs: null,
      awaitingRetry: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('flags a delayed job with failed attempts as awaiting retry', () => {
    const s = toJobSummary(job({ attemptsMade: 1, failedReason: 'boom' }), 'delayed');
    expect(s.awaitingRetry).toBe(true);
    expect(s.failedReason).toBe('boom');
    expect(toJobSummary(job(), 'delayed').awaitingRetry).toBe(false); // plain delayed job
  });

  it('computes durations for finished jobs and exposes results only when completed', () => {
    const t = base.timestamp;
    const done = job({ processedOn: t + 500, finishedOn: t + 1700, returnvalue: { ok: 1 }, attemptsMade: 1 });
    const d = toJobDetail(done, 'completed', []);
    expect(d).toMatchObject({ durationMs: 1200, waitingMs: 500, progress: 100, result: { ok: 1 } });
    expect(toJobDetail(done, 'failed', []).result).toBeNull();
    expect(d.backoff).toEqual({ type: 'exponential', delayMs: 1000 });
  });

  it('exposes only the first line of stack traces', () => {
    const d = toJobDetail(job({ stacktrace: ['Error: secret path\n    at /srv/app/x.js:1:1'] }), 'failed', []);
    expect(d.attemptErrors).toEqual(['Error: secret path']);
    expect(firstLine('A\nB')).toBe('A');
  });

  it('normalises unexpected states and progress values', () => {
    expect(normalizeState('weird')).toBe('unknown');
    expect(normalizeProgress({ step: 2 })).toBe(0);
    expect(normalizeProgress(250)).toBe(100);
  });
});

describe('identifiers', () => {
  it('scopes deduplication ids by job type', () => {
    expect(deduplicationIdFor('report-generation', 'k')).not.toBe(deduplicationIdFor('failure-simulation', 'k'));
  });

  it('generates BullMQ-safe job ids', () => {
    const id = newJobId();
    expect(id).toMatch(/^job_[0-9a-f]{32}$/);
    expect(id).not.toContain(':');
  });

  it('orders Redis stream ids numerically', () => {
    expect(compareStreamIds('1700000000000-10', '1700000000000-9')).toBeGreaterThan(0);
    expect(compareStreamIds('999-0', '1000-0')).toBeLessThan(0);
  });
});
