import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app';
import { createQueueClients } from '../../apps/api/src/queue';
import { createTestContext, silentLogger } from '../helpers/context';

const t = createTestContext('api');
let app: FastifyInstance;

const report = (name = 'Monthly Sales Report', options: Record<string, unknown> = {}) => ({
  type: 'report-generation',
  data: { reportName: name, recordCount: 1000, format: 'json' },
  options,
});

async function submit(payload: unknown) {
  return app.inject({ method: 'POST', url: '/api/v1/jobs', payload: payload as object });
}

beforeAll(async () => {
  await t.ready();
  const config = t.apiConfig();
  app = await buildApp({ config, clients: createQueueClients(config, silentLogger) });
  await app.ready();
});

afterAll(async () => {
  await app.queueClients.close();
  await app.close();
  await t.cleanup();
});

describe('POST /api/v1/jobs', () => {
  it('accepts a valid job with 202 and does not wait for processing', async () => {
    const res = await submit(report());
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toMatchObject({ status: 'waiting', deduplicated: false, message: 'Job accepted for processing' });
    expect(body.jobId).toMatch(/^job_[0-9a-f]{32}$/);
    // No worker is running in this file: the job must still be waiting in Redis.
    expect(await (await t.queue.getJob(body.jobId))!.getState()).toBe('waiting');
  });

  it('places prioritized jobs in the prioritized state', async () => {
    const res = await submit(report('P', { priority: 2 }));
    expect(res.json().status).toBe('prioritized');
  });

  it('rejects invalid payloads with a structured 400', async () => {
    const res = await submit({ type: 'report-generation', data: { reportName: 'x', recordCount: -1 } });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.requestId).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/at .*\.ts:\d+/); // no stack traces
  });

  it('rejects unknown job types', async () => {
    const res = await submit({ type: 'exec', data: { command: 'whoami' } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects non-JSON bodies', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/jobs', payload: 'type=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(res.statusCode).toBe(415);
  });

  it('enforces the payload size limit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ type: 'report-generation', data: { reportName: 'x'.repeat(1_100_000), recordCount: 1 } }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('suppresses a duplicate pending submission and says so explicitly', async () => {
    const first = (await submit(report('Dup', { deduplicationKey: 'api-dup' }))).json();
    const second = await submit(report('Dup', { deduplicationKey: 'api-dup' }));
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      jobId: first.jobId,
      deduplicated: true,
      deduplicationId: 'report-generation:api-dup',
    });
    expect(second.json().message).toMatch(/No new job was created/);
  });
});

describe('POST /api/v1/jobs/batch', () => {
  it('accepts up to 100 jobs and reports deduplicated entries', async () => {
    const jobs = [
      { type: 'failure-simulation', data: {}, options: { deduplicationKey: 'batch-key' } },
      { type: 'failure-simulation', data: {}, options: { deduplicationKey: 'batch-key' } },
      { type: 'failure-simulation', data: {} },
    ];
    const res = await app.inject({ method: 'POST', url: '/api/v1/jobs/batch', payload: { jobs } });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toMatchObject({ accepted: 2, deduplicated: 1 });
    expect(body.jobs[1].jobId).toBe(body.jobs[0].jobId);
  });

  it('rejects batches over the limit', async () => {
    const jobs = Array.from({ length: 101 }, () => ({ type: 'failure-simulation', data: {} }));
    expect((await app.inject({ method: 'POST', url: '/api/v1/jobs/batch', payload: { jobs } })).statusCode).toBe(400);
  });
});

describe('GET /api/v1/jobs/:id', () => {
  it('returns job details', async () => {
    const { jobId } = (await submit(report('Detail'))).json();
    const res = await app.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: jobId,
      type: 'report-generation',
      state: 'waiting',
      progress: 0,
      attemptsMade: 0,
      maxAttempts: 3,
      startedAt: null,
      result: null,
      data: { reportName: 'Detail', recordCount: 1000 },
      backoff: { type: 'exponential', delayMs: 1000 },
      history: [],
    });
  });

  it('returns 404 for unknown ids', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/jobs/job_doesnotexist' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('returns 400 for malformed ids', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/jobs/${encodeURIComponent('bad:id*')}` });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/v1/jobs', () => {
  it('lists with exact pagination for a single state', async () => {
    const page1 = (await app.inject({ method: 'GET', url: '/api/v1/jobs?state=waiting&pageSize=2&page=1' })).json();
    const page2 = (await app.inject({ method: 'GET', url: '/api/v1/jobs?state=waiting&pageSize=2&page=2' })).json();
    expect(page1.exact).toBe(true);
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBeGreaterThanOrEqual(3);
    expect(page1.hasMore).toBe(true);
    const ids = new Set([...page1.items, ...page2.items].map((j: { id: string }) => j.id));
    expect(ids.size).toBe(page1.items.length + page2.items.length);
  });

  it('filters by job type and sorts newest/oldest', async () => {
    const newest = (await app.inject({ method: 'GET', url: '/api/v1/jobs?type=failure-simulation&sort=newest' })).json();
    expect(newest.items.length).toBeGreaterThan(0);
    expect(newest.items.every((j: { type: string }) => j.type === 'failure-simulation')).toBe(true);
    const oldest = (await app.inject({ method: 'GET', url: '/api/v1/jobs?type=failure-simulation&sort=oldest' })).json();
    const created = (r: { items: Array<{ createdAt: string }> }) => r.items.map((j) => Date.parse(j.createdAt));
    expect(created(newest)).toEqual([...created(newest)].sort((a, b) => b - a));
    expect(created(oldest)).toEqual([...created(oldest)].sort((a, b) => a - b));
  });

  it('searches by job id', async () => {
    const { jobId } = (await submit(report('Search'))).json();
    const res = (await app.inject({ method: 'GET', url: `/api/v1/jobs?search=${jobId.slice(4, 16)}` })).json();
    expect(res.items.map((j: { id: string }) => j.id)).toContain(jobId);
  });

  it('rejects invalid filters', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/jobs?state=exploded' })).statusCode).toBe(400);
  });
});

describe('GET /api/v1/queues/stats', () => {
  it('returns real counts from BullMQ', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/queues/stats' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const expected = await t.queue.getJobCounts('waiting', 'prioritized', 'active', 'delayed', 'completed', 'failed');
    expect(body.counts).toMatchObject(expected);
    expect(body.pending).toBe(expected.waiting! + expected.prioritized!);
  });
});

describe('retry and cancel', () => {
  it('refuses to retry a job that has not failed', async () => {
    const { jobId } = (await submit(report('NoRetry'))).json();
    const res = await app.inject({ method: 'POST', url: `/api/v1/jobs/${jobId}/retry` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('JOB_NOT_RETRYABLE');
  });

  it('retries a terminally failed job', async () => {
    const { jobId } = (await submit({ type: 'failure-simulation', data: { durationMs: 0, steps: 1, failFirstAttempts: 1, failureMode: 'permanent' } })).json();
    const worker = await t.startInProcessWorker();
    const failed = await t.waitForFinished(jobId);
    expect(await failed.getState()).toBe('failed');
    await worker.worker.pause(); // keep the retried job waiting so the response state is observable

    const res = await app.inject({ method: 'POST', url: `/api/v1/jobs/${jobId}/retry` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ jobId, previousState: 'failed' });
    expect(['waiting', 'active', 'completed']).toContain(res.json().status);
    worker.worker.resume();
    const done = await t.waitForFinished(jobId);
    // attemptsMade was reset, so failFirstAttempts=1 fails it once more; that's deterministic.
    expect(await done.getState()).toBe('failed');
    expect(done.attemptsMade).toBe(1);
    await worker.close();
  });

  it('cancels a delayed job and keeps a cancelled tombstone', async () => {
    const { jobId } = (await submit({ type: 'failure-simulation', data: {}, options: { delayMs: 60_000 } })).json();
    const res = await app.inject({ method: 'POST', url: `/api/v1/jobs/${jobId}/cancel` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ jobId, previousState: 'delayed', status: 'cancelled' });
    expect(await t.queue.getJob(jobId)).toBeUndefined();
    const detail = (await app.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}` })).json();
    expect(detail.state).toBe('cancelled');
    expect(detail.cancelledAt).toBeTruthy();
    const again = await app.inject({ method: 'POST', url: `/api/v1/jobs/${jobId}/cancel` });
    expect(again.statusCode).toBe(404);
  });

  it('refuses to cancel an active job', async () => {
    const { jobId } = (await submit({ type: 'failure-simulation', data: { durationMs: 3000, steps: 3 } })).json();
    const active = t.onceJobEvent('active', jobId, 15_000);
    const worker = await t.startInProcessWorker();
    await active;
    const res = await app.inject({ method: 'POST', url: `/api/v1/jobs/${jobId}/cancel` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('JOB_ACTIVE');
    await worker.close();
  });
});

describe('system endpoints', () => {
  it('reports liveness and readiness', async () => {
    expect((await app.inject({ method: 'GET', url: '/health/live' })).json().status).toBe('ok');
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().checks.redis.status).toBe('up');
  });

  it('publishes an OpenAPI document', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toMatch(/^3\./);
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/api/v1/jobs', '/api/v1/jobs/{id}', '/api/v1/queues/stats']));
  });

  it('does not expose demo crash controls unless explicitly enabled', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/demo/workers/anything/crash' });
    expect(res.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/config' })).json().demoControlsEnabled).toBe(false);
  });

  it('only allows configured CORS origins', async () => {
    const allowed = await app.inject({ method: 'GET', url: '/health/live', headers: { origin: 'http://localhost:5173' } });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const denied = await app.inject({ method: 'GET', url: '/health/live', headers: { origin: 'https://evil.example' } });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns JSON 404s for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ROUTE_NOT_FOUND');
  });
});
