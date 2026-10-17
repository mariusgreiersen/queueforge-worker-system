import { z } from 'zod';
import { DEFAULT_KEY_PREFIX, QUEUE_NAME } from '@queueforge/shared';
import { envBoolean, envInt, parseEnv } from '@queueforge/shared/node';

const apiEnvSchema = z.object({
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: envInt(3000, 0, 65_535),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  QUEUE_PREFIX: z.string().regex(/^[A-Za-z0-9_-]+$/).default(DEFAULT_KEY_PREFIX),
  QUEUE_NAME: z.string().regex(/^[A-Za-z0-9_-]+$/).default(QUEUE_NAME),
  /** Comma-separated list of allowed browser origins. */
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:8080'),
  /** Upper bound for any Redis-backed operation on the request path. */
  REDIS_OPERATION_TIMEOUT_MS: envInt(3_000, 100, 60_000),
  /** Per-state number of most recent jobs scanned for filtered / multi-state listings. */
  LIST_SCAN_WINDOW: envInt(200, 10, 5_000),
  KEEP_COMPLETED_COUNT: envInt(1_000, 0, 1_000_000),
  KEEP_COMPLETED_AGE_SECONDS: envInt(24 * 60 * 60, 0, 30 * 24 * 60 * 60),
  KEEP_FAILED_COUNT: envInt(5_000, 0, 1_000_000),
  KEEP_FAILED_AGE_SECONDS: envInt(7 * 24 * 60 * 60, 0, 90 * 24 * 60 * 60),
  /** LOCAL DEVELOPMENT ONLY: exposes the worker crash endpoint used by the Reliability Playground. */
  DEMO_CONTROLS_ENABLED: envBoolean(false),
  /** Include internal error messages in 500 responses. Never enable on a public deployment. */
  EXPOSE_ERROR_DETAILS: envBoolean(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: envBoolean(false),
});

export interface ApiConfig {
  host: string;
  port: number;
  redisUrl: string;
  prefix: string;
  queueName: string;
  corsOrigins: string[];
  redisOperationTimeoutMs: number;
  listScanWindow: number;
  retention: {
    completedCount: number;
    completedAgeSeconds: number;
    failedCount: number;
    failedAgeSeconds: number;
  };
  demoControlsEnabled: boolean;
  exposeErrorDetails: boolean;
  logLevel: string;
  logPretty: boolean;
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const e = parseEnv(apiEnvSchema, env);
  return {
    host: e.API_HOST,
    port: e.API_PORT,
    redisUrl: e.REDIS_URL,
    prefix: e.QUEUE_PREFIX,
    queueName: e.QUEUE_NAME,
    corsOrigins: e.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    redisOperationTimeoutMs: e.REDIS_OPERATION_TIMEOUT_MS,
    listScanWindow: e.LIST_SCAN_WINDOW,
    retention: {
      completedCount: e.KEEP_COMPLETED_COUNT,
      completedAgeSeconds: e.KEEP_COMPLETED_AGE_SECONDS,
      failedCount: e.KEEP_FAILED_COUNT,
      failedAgeSeconds: e.KEEP_FAILED_AGE_SECONDS,
    },
    demoControlsEnabled: e.DEMO_CONTROLS_ENABLED,
    exposeErrorDetails: e.EXPOSE_ERROR_DETAILS,
    logLevel: e.LOG_LEVEL,
    logPretty: e.LOG_PRETTY,
  };
}
