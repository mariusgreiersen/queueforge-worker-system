import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  JOB_ID_PATTERN,
  batchSubmitResponseSchema,
  batchSubmitSchema,
  errorResponseSchema,
  jobDetailSchema,
  listJobsQuerySchema,
  listJobsResponseSchema,
  submitJobResponseSchema,
  submitJobSchema,
} from '@queueforge/shared';
import type { JobService } from '../services/job-service';

const jobIdParams = z.object({
  id: z.string().regex(JOB_ID_PATTERN, 'Job ids contain only letters, digits, "_" and "-" (max 100 chars)'),
});

const errors = { 400: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema, 503: errorResponseSchema };

export const jobRoutes: FastifyPluginAsyncZod<{ service: JobService }> = async (app, { service }) => {
  app.post(
    '/jobs',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Submit a job',
        description:
          'Validates the payload, enqueues the job in Redis and returns immediately (202). If `options.deduplicationKey` matches a job that is still pending or active, no job is created: the response is 200 with `deduplicated: true` and the existing job id.',
        body: submitJobSchema,
        response: { 202: submitJobResponseSchema, 200: submitJobResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const result = await service.submit(request.body);
      request.log.info(
        { event: result.deduplicated ? 'job.deduplicated' : 'job.accepted', jobId: result.jobId, jobType: request.body.type },
        result.deduplicated ? 'Duplicate submission suppressed' : 'Job accepted',
      );
      return reply.status(result.deduplicated ? 200 : 202).send(result);
    },
  );

  app.post(
    '/jobs/batch',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Submit up to 100 jobs in one request',
        body: batchSubmitSchema,
        response: { 202: batchSubmitResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const result = await service.submitBatch(request.body.jobs);
      request.log.info({ event: 'job.batch_accepted', accepted: result.accepted, deduplicated: result.deduplicated }, 'Batch accepted');
      return reply.status(202).send(result);
    },
  );

  app.get(
    '/jobs',
    {
      schema: {
        tags: ['jobs'],
        summary: 'List jobs',
        description:
          'Single-state listings without filters use exact BullMQ range pagination (`exact: true`). Listings across all states, or filtered by type/search, are assembled from a bounded window of the most recent jobs per state (`exact: false` when a state holds more jobs than the window).',
        querystring: listJobsQuerySchema,
        response: { 200: listJobsResponseSchema, ...errors },
      },
    },
    async (request) => service.list(request.query),
  );

  app.get(
    '/jobs/:id',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Get a job',
        params: jobIdParams,
        response: { 200: jobDetailSchema, ...errors },
      },
    },
    async (request) => service.get(request.params.id),
  );

  app.post(
    '/jobs/:id/retry',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Manually retry a failed job',
        description: 'Only jobs in the terminal `failed` state can be retried. The attempt counter is reset, granting a fresh retry budget.',
        params: jobIdParams,
        response: {
          200: z.object({ jobId: z.string(), previousState: z.string(), status: z.string() }),
          ...errors,
        },
      },
    },
    async (request) => service.retry(request.params.id),
  );

  app.post(
    '/jobs/:id/cancel',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Cancel a job that has not started',
        description:
          'Removes waiting, prioritized or delayed jobs. Active jobs are refused with 409: no cooperative cancellation is implemented, so a running processor cannot be stopped.',
        params: jobIdParams,
        response: {
          200: z.object({ jobId: z.string(), previousState: z.string(), status: z.literal('cancelled') }),
          ...errors,
        },
      },
    },
    async (request) => service.cancel(request.params.id),
  );
};
