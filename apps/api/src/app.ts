import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { LIMITS } from '@queueforge/shared';
import { createLogger, loggerOptions, type Logger } from '@queueforge/shared/node';
import type { ApiConfig } from './config';
import { registerErrorHandling } from './middleware/errors';
import { createQueueClients, type QueueClients } from './queue';
import { healthRoutes, systemRoutes } from './routes/system';
import { jobRoutes } from './routes/jobs';
import { EventHub } from './services/event-hub';
import { JobService } from './services/job-service';

export interface BuildAppOptions {
  config: ApiConfig;
  /** Inject pre-built clients (tests). When omitted, the app creates and owns them. */
  clients?: QueueClients;
}

/** One structured line per completed request; health probes and the long-lived SSE stream are skipped. */
class ApiLogController extends LogController {
  constructor() {
    super({
      disableRequestLogging: (request: FastifyRequest) =>
        request.url.startsWith('/health') || request.url.startsWith('/api/v1/events'),
    });
  }

  override incomingRequest() {}

  override requestCompleted(error: Error | null, request: FastifyRequest, reply: FastifyReply) {
    const fields = {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    };
    if (error) reply.log.error({ ...fields, err: error }, 'request errored');
    else reply.log.info(fields, 'request completed');
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    jobService: JobService;
    queueClients: QueueClients;
  }
}

export async function buildApp({ config, clients: injected }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions({ service: 'queueforge-api', level: config.logLevel, pretty: config.logPretty }),
    bodyLimit: LIMITS.bodyLimitBytes,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    logController: new ApiLogController(),
    // Return 503 for requests that arrive while the server is closing.
    return503OnClosing: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app, { exposeErrorDetails: config.exposeErrorDetails });

  const logger = app.log as unknown as Logger;
  const clients = injected ?? createQueueClients(config, logger);
  const service = new JobService(clients, config);
  const hub = new EventHub(clients.events, clients.queue, logger);
  hub.start();
  app.decorate('jobService', service);
  app.decorate('queueClients', clients);

  let shuttingDown = false;
  app.addHook('preClose', async () => {
    shuttingDown = true;
    hub.closeClients();
  });
  app.addHook('onClose', async () => {
    if (!injected) await clients.close();
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      // Non-browser clients (curl, server-to-server) send no Origin header.
      if (!origin || config.corsOrigins.includes(origin)) cb(null, true);
      else cb(null, false);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-request-id', 'last-event-id'],
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'QueueForge API',
        description: 'Submit and inspect background jobs processed by independent BullMQ workers.',
        version: '1.0.0',
      },
      tags: [
        { name: 'jobs' },
        { name: 'queues' },
        { name: 'workers' },
        { name: 'events' },
        { name: 'health' },
        { name: 'system' },
        { name: 'demo', description: 'Local development only; disabled by default' },
      ],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  await app.register(healthRoutes, { service, isShuttingDown: () => shuttingDown });
  await app.register(
    async (v1) => {
      await v1.register(jobRoutes, { service });
      await v1.register(systemRoutes, { service, hub, config });
    },
    { prefix: '/api/v1' },
  );

  return app;
}

export { createLogger };
