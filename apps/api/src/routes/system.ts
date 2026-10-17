import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  RETRY_POLICY,
  errorResponseSchema,
  healthResponseSchema as health,
  queueStatsSchema,
  serverConfigSchema,
  workersResponseSchema,
} from '@queueforge/shared';
import type { ApiConfig } from '../config';
import type { EventHub } from '../services/event-hub';
import type { JobService } from '../services/job-service';

interface SystemRouteOptions {
  service: JobService;
  hub: EventHub;
  config: ApiConfig;
}

export const systemRoutes: FastifyPluginAsyncZod<SystemRouteOptions> = async (app, { service, hub, config }) => {
  app.get(
    '/queues/stats',
    {
      schema: {
        tags: ['queues'],
        summary: 'Live job counts per state (from BullMQ)',
        response: { 200: queueStatsSchema, 503: errorResponseSchema },
      },
    },
    async () => service.stats(),
  );

  app.get(
    '/workers',
    {
      schema: {
        tags: ['workers'],
        summary: 'Workers with a recent heartbeat',
        description:
          'Built from heartbeat keys that workers refresh every 5 s with a 15 s TTL. `fresh` is a health estimate, not a liveness guarantee; job ownership is governed by BullMQ locks.',
        response: { 200: workersResponseSchema, 503: errorResponseSchema },
      },
    },
    async () => service.workers(),
  );

  app.get(
    '/config',
    { schema: { tags: ['system'], summary: 'Public server configuration', response: { 200: serverConfigSchema } } },
    async () => ({
      queue: config.queueName,
      demoControlsEnabled: config.demoControlsEnabled,
      retryPolicy: {
        defaultAttempts: RETRY_POLICY.defaultAttempts,
        maxAttempts: RETRY_POLICY.maxAttempts,
        defaultBackoffDelayMs: RETRY_POLICY.defaultBackoffDelayMs,
        maxBackoffDelayMs: RETRY_POLICY.maxBackoffDelayMs,
      },
      retention: config.retention,
    }),
  );

  app.get(
    '/events',
    {
      schema: {
        tags: ['events'],
        summary: 'Server-Sent Events stream of queue lifecycle events',
        description:
          'Each message has `event: queue-event` and a JSON payload. Supports `Last-Event-ID` for replay from a bounded in-memory buffer. Treat events as change notifications and refetch authoritative state from the REST endpoints.',
      },
    },
    (request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        ...(reply.getHeaders() as Record<string, string>),
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const lastEventId = request.headers['last-event-id'];
      hub.attach(reply.raw, typeof lastEventId === 'string' ? lastEventId : undefined);
    },
  );

  if (config.demoControlsEnabled) {
    app.post(
      '/demo/workers/:workerId/crash',
      {
        schema: {
          tags: ['demo'],
          summary: 'LOCAL DEV ONLY: SIGKILL a worker that opted in to crash commands',
          description:
            'Registered only when DEMO_CONTROLS_ENABLED=true, and only affects workers started with WORKER_ALLOW_CRASH_COMMANDS=true. Never enable on a reachable deployment.',
          params: z.object({ workerId: z.string().regex(/^[A-Za-z0-9_.-]{1,200}$/) }),
          response: {
            202: z.object({ workerId: z.string(), delivered: z.int(), message: z.string() }),
            404: errorResponseSchema,
            409: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const result = await service.crashWorker(request.params.workerId);
        request.log.warn({ event: 'demo.worker_crash_requested', workerId: result.workerId }, 'Crash command published');
        return reply.status(202).send({
          ...result,
          message: 'Crash command delivered. The worker will terminate with SIGKILL; its active jobs will stall and be recovered.',
        });
      },
    );
  }
};

export const healthRoutes: FastifyPluginAsyncZod<{ service: JobService; isShuttingDown: () => boolean }> = async (
  app,
  { service, isShuttingDown },
) => {
  app.get(
    '/health/live',
    { schema: { tags: ['health'], summary: 'Process liveness', response: { 200: health } } },
    async () => ({ status: 'ok' as const, uptimeSeconds: Math.round(process.uptime()) }),
  );

  app.get(
    '/health/ready',
    {
      schema: {
        tags: ['health'],
        summary: 'Readiness: Redis reachable and not shutting down',
        response: { 200: health, 503: health },
      },
    },
    async (_request, reply) => {
      const shuttingDown = isShuttingDown();
      let redis: { status: 'up' | 'down'; latencyMs: number | null; error?: string };
      try {
        redis = { status: 'up', latencyMs: await service.ping(1_000) };
      } catch (err) {
        redis = { status: 'down', latencyMs: null, error: (err as Error).message };
      }
      const ready = redis.status === 'up' && !shuttingDown;
      return reply.status(ready ? 200 : 503).send({
        status: ready ? 'ready' : 'not-ready',
        uptimeSeconds: Math.round(process.uptime()),
        checks: { redis, shuttingDown },
      });
    },
  );
};
