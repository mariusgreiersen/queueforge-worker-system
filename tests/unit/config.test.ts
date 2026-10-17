import { describe, expect, it } from 'vitest';
import { ConfigError, parseRedisUrl, redisOptions } from '@queueforge/shared/node';
import { loadApiConfig } from '../../apps/api/src/config';
import { loadWorkerConfig } from '../../apps/worker/src/config';

describe('worker configuration', () => {
  it('uses documented defaults', () => {
    const c = loadWorkerConfig({ WORKER_ID: 'w1' });
    expect(c).toMatchObject({
      workerId: 'w1',
      concurrency: 3,
      lockDurationMs: 15_000,
      stalledIntervalMs: 5_000,
      maxStalledCount: 2,
      allowCrashCommands: false,
      prefix: 'qf',
      queueName: 'queueforge',
    });
  });

  it('parses overrides and booleans', () => {
    const c = loadWorkerConfig({ WORKER_CONCURRENCY: '8', WORKER_ALLOW_CRASH_COMMANDS: 'true', LOG_PRETTY: '1' });
    expect(c.concurrency).toBe(8);
    expect(c.allowCrashCommands).toBe(true);
    expect(c.logPretty).toBe(true);
  });

  it('derives a unique worker id from host, pid and a per-process suffix when none is given', () => {
    const a = loadWorkerConfig({}).workerId;
    expect(a).toMatch(new RegExp('-' + process.pid + '-[0-9a-f]{4}$'));
    expect(loadWorkerConfig({}).workerId).not.toBe(a);
  });

  it('treats empty strings as unset', () => {
    expect(loadWorkerConfig({ WORKER_CONCURRENCY: '' }).concurrency).toBe(3);
  });

  it.each([
    ['concurrency 0', { WORKER_CONCURRENCY: '0' }],
    ['non-numeric lock duration', { WORKER_LOCK_DURATION_MS: 'soon' }],
    ['lock duration below 1s', { WORKER_LOCK_DURATION_MS: '10' }],
    ['invalid boolean', { WORKER_ALLOW_CRASH_COMMANDS: 'maybe' }],
    ['prefix with colon', { QUEUE_PREFIX: 'a:b' }],
  ])('rejects %s', (_name, env) => {
    expect(() => loadWorkerConfig(env)).toThrow(ConfigError);
  });
});

describe('API configuration', () => {
  it('disables demo controls by default', () => {
    expect(loadApiConfig({}).demoControlsEnabled).toBe(false);
    expect(loadApiConfig({}).exposeErrorDetails).toBe(false);
  });

  it('splits CORS origins', () => {
    expect(loadApiConfig({ CORS_ORIGINS: 'http://a.test, http://b.test,' }).corsOrigins).toEqual(['http://a.test', 'http://b.test']);
  });
});

describe('Redis connection options', () => {
  it('parses Redis URLs', () => {
    expect(parseRedisUrl('redis://user:p%40ss@cache.internal:6380/2')).toEqual({
      host: 'cache.internal',
      port: 6380,
      username: 'user',
      password: 'p@ss',
      db: 2,
      tls: false,
    });
    expect(parseRedisUrl('rediss://localhost').tls).toBe(true);
    expect(() => parseRedisUrl('http://localhost')).toThrow();
  });

  it('fails fast on the API command path and blocks/reconnects on the worker path', () => {
    const command = redisOptions('redis://localhost:6379', 'command');
    expect(command.enableOfflineQueue).toBe(false);
    expect(command.maxRetriesPerRequest).toBe(1);
    const blocking = redisOptions('redis://localhost:6379', 'blocking');
    expect(blocking.maxRetriesPerRequest).toBeNull();
    expect(blocking.enableOfflineQueue).toBe(true);
    expect(blocking.retryStrategy(100)).toBeLessThanOrEqual(10_000);
  });
});
