import { randomUUID } from 'node:crypto';
import type { Job, JobsOptions, JobType as BullJobType } from 'bullmq';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TTL_SECONDS,
  METADATA_TTL_SECONDS,
  RETRY_POLICY,
  workerHeartbeatSchema,
  type BatchSubmitResponse,
  type JobDetail,
  type JobState,
  type ListJobsQuery,
  type ListJobsResponse,
  type QueueStats,
  type SubmitJobInput,
  type SubmitJobResponse,
  type WorkersResponse,
} from '@queueforge/shared';
import { readHistory } from '@queueforge/shared/node';
import type { ApiConfig } from '../config';
import { AppError, conflict, notFound, withRedisTimeout } from '../middleware/errors';
import type { QueueClients } from '../queue';
import { normalizeState, toJobDetail, toJobSummary } from './job-mapper';

const LISTABLE_STATES: JobState[] = ['waiting', 'prioritized', 'active', 'delayed', 'completed', 'failed'];

/** Deduplication ids are scoped by job type so equal keys for different job types never collide. */
export const deduplicationIdFor = (type: string, key: string) => `${type}:${key}`;

export const newJobId = () => `job_${randomUUID().replaceAll('-', '')}`;

export class JobService {
  constructor(
    private readonly clients: QueueClients,
    private readonly config: ApiConfig,
  ) {}

  private run<T>(op: Promise<T>): Promise<T> {
    return withRedisTimeout(op, this.config.redisOperationTimeoutMs);
  }

  /** Translate the public submission envelope into BullMQ job options, applying server limits. */
  buildJobOptions(input: SubmitJobInput, jobId: string): JobsOptions {
    const o = input.options ?? {};
    const { retention } = this.config;
    return {
      jobId,
      attempts: o.attempts ?? RETRY_POLICY.defaultAttempts,
      backoff: { type: 'exponential', delay: o.backoffDelayMs ?? RETRY_POLICY.defaultBackoffDelayMs },
      ...(o.priority ? { priority: o.priority } : {}),
      ...(o.delayMs ? { delay: o.delayMs } : {}),
      // Simple Mode: no TTL. The key is held until the job completes or fails, then released.
      ...(o.deduplicationKey ? { deduplication: { id: deduplicationIdFor(input.type, o.deduplicationKey) } } : {}),
      removeOnComplete: { count: retention.completedCount, age: retention.completedAgeSeconds },
      removeOnFail: { count: retention.failedCount, age: retention.failedAgeSeconds },
      stackTraceLimit: 10,
    };
  }

  private async describeSubmission(job: Job, requestedId: string): Promise<SubmitJobResponse> {
    // BullMQ returns the *existing* job's id when the deduplication key is already held.
    const deduplicated = job.id !== requestedId;
    const state = normalizeState(await job.getState());
    const deduplicationId = (job.opts.deduplication?.id as string | undefined) ?? null;
    return {
      jobId: job.id!,
      status: state,
      deduplicated,
      deduplicationId,
      message: deduplicated
        ? `Duplicate submission suppressed: job ${job.id} with deduplication id "${deduplicationId}" is still ${state}. No new job was created.`
        : 'Job accepted for processing',
    };
  }

  async submit(input: SubmitJobInput): Promise<SubmitJobResponse> {
    const jobId = newJobId();
    return this.run(
      (async () => {
        const job = await this.clients.queue.add(input.type, input.data, this.buildJobOptions(input, jobId));
        return this.describeSubmission(job, jobId);
      })(),
    );
  }

  async submitBatch(inputs: SubmitJobInput[]): Promise<BatchSubmitResponse> {
    const ids = inputs.map(() => newJobId());
    return this.run(
      (async () => {
        const jobs = await this.clients.queue.addBulk(
          inputs.map((input, i) => ({ name: input.type, data: input.data, opts: this.buildJobOptions(input, ids[i]!) })),
        );
        const described = await Promise.all(jobs.map((job, i) => this.describeSubmission(job, ids[i]!)));
        const deduplicated = described.filter((d) => d.deduplicated).length;
        return { accepted: described.length - deduplicated, deduplicated, jobs: described };
      })(),
    );
  }

  async get(id: string): Promise<JobDetail> {
    return this.run(
      (async () => {
        const job = await this.clients.queue.getJob(id);
        if (!job) {
          const tombstone = await this.clients.redis.get(this.clients.keys.cancelled(id));
          if (tombstone) return JSON.parse(tombstone) as JobDetail;
          throw notFound(`Job ${id}`);
        }
        const [state, history] = await Promise.all([job.getState(), readHistory(this.clients.redis, this.clients.keys, id)]);
        return toJobDetail(job, state, history);
      })(),
    );
  }

  async list(query: ListJobsQuery): Promise<ListJobsResponse> {
    return this.run(this.listUnbounded(query));
  }

  private async listUnbounded(query: ListJobsQuery): Promise<ListJobsResponse> {
    const { queue } = this.clients;
    const { page, pageSize } = query;
    const asc = query.sort === 'oldest';

    // Fast, exact path: one state, no filters -> native BullMQ range pagination.
    if (query.state !== 'all' && !query.type && !query.search) {
      const start = (page - 1) * pageSize;
      const [jobs, total] = await Promise.all([
        queue.getJobs([query.state as BullJobType], start, start + pageSize - 1, asc),
        queue.getJobCountByTypes(query.state as BullJobType),
      ]);
      const items = jobs.filter(Boolean).map((j) => toJobSummary(j, query.state));
      return { items, page, pageSize, total, hasMore: start + items.length < total, exact: true };
    }

    // Filtered path: BullMQ has no secondary index by job name, so scan a bounded window of the
    // most recent jobs in each requested state, then filter, sort and paginate in memory.
    const states = query.state === 'all' ? LISTABLE_STATES : [query.state];
    const window = this.config.listScanWindow;
    const [counts, ...perState] = await Promise.all([
      queue.getJobCounts(...(states as BullJobType[])),
      ...states.map(async (state) => {
        const jobs = await queue.getJobs([state as BullJobType], 0, window - 1, false);
        return jobs.filter(Boolean).map((job) => ({ job, state }));
      }),
    ]);
    const exact = states.every((s) => (counts[s] ?? 0) <= window);
    const search = query.search?.toLowerCase();
    const matches = perState
      .flat()
      .filter(({ job }) => !query.type || job.name === query.type)
      .filter(({ job }) => !search || job.id!.toLowerCase().includes(search))
      .sort((a, b) => (asc ? a.job.timestamp - b.job.timestamp : b.job.timestamp - a.job.timestamp));

    const start = (page - 1) * pageSize;
    const items = matches.slice(start, start + pageSize).map(({ job, state }) => toJobSummary(job, state));
    return { items, page, pageSize, total: matches.length, hasMore: start + items.length < matches.length, exact };
  }

  async stats(): Promise<QueueStats> {
    return this.run(
      (async () => {
        const { queue } = this.clients;
        const [c, isPaused] = await Promise.all([
          queue.getJobCounts('waiting', 'prioritized', 'active', 'delayed', 'completed', 'failed', 'waiting-children'),
          queue.isPaused(),
        ]);
        const counts = {
          waiting: c.waiting ?? 0,
          prioritized: c.prioritized ?? 0,
          active: c.active ?? 0,
          delayed: c.delayed ?? 0,
          completed: c.completed ?? 0,
          failed: c.failed ?? 0,
          waitingChildren: c['waiting-children'] ?? 0,
        };
        return {
          queue: this.config.queueName,
          counts,
          pending: counts.waiting + counts.prioritized,
          isPaused,
          timestamp: new Date().toISOString(),
        };
      })(),
    );
  }

  /** Manually retry a job that exhausted its attempts. Grants a fresh attempt budget. */
  async retry(id: string): Promise<{ jobId: string; previousState: string; status: string }> {
    return this.run(
      (async () => {
        const job = await this.clients.queue.getJob(id);
        if (!job) throw notFound(`Job ${id}`);
        const state = await job.getState();
        if (state !== 'failed') {
          throw conflict('JOB_NOT_RETRYABLE', `Only failed jobs can be retried manually; job ${id} is ${state}.`);
        }
        try {
          await job.retry('failed', { resetAttemptsMade: true });
        } catch (err) {
          throw conflict('JOB_NOT_RETRYABLE', `Job ${id} could not be retried: ${(err as Error).message}`);
        }
        return { jobId: id, previousState: state, status: normalizeState(await job.getState()) };
      })(),
    );
  }

  /**
   * Cancel a job that has not started. Active jobs are refused: QueueForge does not implement
   * cooperative cancellation, so it cannot stop a processor that is already running.
   */
  async cancel(id: string): Promise<{ jobId: string; previousState: string; status: 'cancelled' }> {
    return this.run(
      (async () => {
        const { queue, redis, keys } = this.clients;
        const job = await queue.getJob(id);
        if (!job) throw notFound(`Job ${id}`);
        const state = await job.getState();
        if (state === 'active') {
          throw conflict(
            'JOB_ACTIVE',
            `Job ${id} is currently executing and cannot be cancelled (no cooperative cancellation is implemented).`,
          );
        }
        if (state === 'completed' || state === 'failed') {
          throw conflict('JOB_FINISHED', `Job ${id} already ${state}; there is nothing to cancel.`);
        }
        const history = await readHistory(redis, keys, id);
        const snapshot = toJobDetail(job, state, history);
        try {
          // BullMQ's remove is atomic and refuses to remove a job locked by a worker, which closes
          // the race where a worker picks the job up between getState() and remove().
          await job.remove();
        } catch (err) {
          throw conflict('JOB_ACTIVE', `Job ${id} started processing before it could be cancelled: ${(err as Error).message}`);
        }
        const now = new Date().toISOString();
        await redis.set(
          keys.cancelled(id),
          JSON.stringify({ ...snapshot, state: 'cancelled', cancelledAt: now, awaitingRetry: false } satisfies JobDetail),
          'EX',
          METADATA_TTL_SECONDS,
        );
        return { jobId: id, previousState: state, status: 'cancelled' };
      })(),
    );
  }

  async workers(): Promise<WorkersResponse> {
    return this.run(
      (async () => {
        const { redis, keys } = this.clients;
        const found: string[] = [];
        let cursor = '0';
        do {
          const [next, batch] = await redis.scan(cursor, 'MATCH', keys.heartbeatPattern, 'COUNT', 200);
          cursor = next;
          found.push(...batch);
        } while (cursor !== '0' && found.length < 1_000);
        const values = found.length ? await redis.mget(...found) : [];
        const now = Date.now();
        const workers = values
          .flatMap((v) => {
            if (!v) return [];
            const parsed = workerHeartbeatSchema.safeParse(JSON.parse(v));
            return parsed.success ? [parsed.data] : [];
          })
          .map((w) => {
            const heartbeatAgeMs = Math.max(0, now - Date.parse(w.lastHeartbeatAt));
            return { ...w, heartbeatAgeMs, fresh: heartbeatAgeMs < HEARTBEAT_INTERVAL_MS * 2 };
          })
          .sort((a, b) => a.workerId.localeCompare(b.workerId));
        return { workers, heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS, heartbeatTtlSeconds: HEARTBEAT_TTL_SECONDS };
      })(),
    );
  }

  /** LOCAL DEV ONLY. Ask a worker (that opted in) to SIGKILL itself. */
  async crashWorker(workerId: string): Promise<{ workerId: string; delivered: number }> {
    return this.run(
      (async () => {
        const { redis, keys } = this.clients;
        if (!(await redis.exists(keys.heartbeat(workerId)))) throw notFound(`Worker ${workerId}`);
        const delivered = await redis.publish(keys.controlChannel(workerId), 'crash');
        if (delivered === 0) {
          throw new AppError(
            409,
            'WORKER_NOT_ACCEPTING_COMMANDS',
            `Worker ${workerId} is not subscribed to crash commands (WORKER_ALLOW_CRASH_COMMANDS is not enabled).`,
          );
        }
        return { workerId, delivered };
      })(),
    );
  }

  async ping(timeoutMs: number): Promise<number> {
    const started = performance.now();
    await withRedisTimeout(this.clients.redis.ping(), timeoutMs);
    return Math.round((performance.now() - started) * 100) / 100;
  }
}
