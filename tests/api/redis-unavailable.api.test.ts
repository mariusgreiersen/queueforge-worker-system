import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app';
import { loadApiConfig } from '../../apps/api/src/config';

/**
 * The API pointed at a port where nothing listens. Requests must fail fast with 503 rather than
 * hang, readiness must report not-ready, and liveness must stay healthy (the process is fine).
 */
let app: FastifyInstance;
const TIMEOUT_MS = 1_500;

beforeAll(async () => {
  app = await buildApp({
    config: loadApiConfig({ REDIS_URL: 'redis://127.0.0.1:1', LOG_LEVEL: 'silent', REDIS_OPERATION_TIMEOUT_MS: String(TIMEOUT_MS) }),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('API with Redis unavailable', () => {
  it('rejects job submission with 503 within the operation timeout', async () => {
    const started = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      payload: { type: 'failure-simulation', data: {} },
    });
    const elapsed = Date.now() - started;
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('REDIS_UNAVAILABLE');
    expect(elapsed).toBeLessThan(TIMEOUT_MS + 1_000);
  });

  it('returns 503 for reads as well', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/queues/stats' })).statusCode).toBe(503);
    expect((await app.inject({ method: 'GET', url: '/api/v1/jobs/job_x' })).statusCode).toBe(503);
  });

  it('reports not-ready but stays live', async () => {
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ status: 'not-ready', checks: { redis: { status: 'down' } } });
    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
  });

  it('still validates input before touching Redis', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/jobs', payload: { type: 'nope' } });
    expect(res.statusCode).toBe(400);
  });
});
