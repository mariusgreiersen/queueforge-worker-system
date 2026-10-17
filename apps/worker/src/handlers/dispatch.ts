import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { JOB_TYPES, jobDataSchemas, type ExecutionEvent, type JobType } from '@queueforge/shared';
import type { Logger, MetaKeys } from '@queueforge/shared/node';
import { classifyError, errorMessage, PermanentJobError } from '../errors';
import { processors as defaultProcessors } from '../processors';
import type { Processor } from '../processors/context';

export interface DispatchDeps {
  redis: Redis;
  keys: MetaKeys;
  workerId: string;
  logger: Logger;
  recordHistory: (jobId: string, event: ExecutionEvent) => Promise<void>;
  loadHistory: (jobId: string) => Promise<ExecutionEvent[]>;
  processors?: Partial<Record<JobType, Processor<never, unknown>>>;
}

/** The subset of BullMQ's Job the dispatcher relies on (keeps it unit-testable). */
export type DispatchableJob = Pick<
  Job,
  'id' | 'name' | 'data' | 'attemptsMade' | 'attemptsStarted' | 'opts' | 'updateProgress'
>;

const isJobType = (name: string): name is JobType => (JOB_TYPES as readonly string[]).includes(name);

export function createJobHandler(deps: DispatchDeps) {
  const registry = { ...defaultProcessors, ...deps.processors } as Record<JobType, Processor<unknown, unknown>>;

  return async function handle(job: DispatchableJob): Promise<unknown> {
    const jobId = job.id!;
    const execution = job.attemptsStarted;
    const maxAttempts = job.opts.attempts ?? 1;
    const log = deps.logger.child({ jobId, jobType: job.name, execution, attempt: job.attemptsMade + 1 });

    if (!isJobType(job.name)) {
      throw new PermanentJobError(`Unsupported job type "${job.name}"`);
    }

    // Defence in depth: the API validated this payload, but Redis contents are re-checked before
    // they reach a processor. Invalid input can never succeed, so it is a permanent failure.
    const parsed = jobDataSchemas[job.name].safeParse(job.data);
    if (!parsed.success) {
      const message = `Invalid job data: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
      await deps.recordHistory(jobId, {
        event: 'failed',
        workerId: deps.workerId,
        execution,
        attemptsMade: job.attemptsMade,
        at: new Date().toISOString(),
        message,
        willRetry: false,
      });
      throw new PermanentJobError(message);
    }

    // If the previous execution started but never recorded an outcome, its worker vanished and
    // BullMQ's stalled checker returned the job to the queue. Record that before this start.
    if (execution > 1) {
      const history = await deps.loadHistory(jobId);
      const last = history.at(-1);
      if (last?.event === 'started') {
        await deps.recordHistory(jobId, {
          event: 'stalled-recovered',
          workerId: deps.workerId,
          execution: last.execution,
          attemptsMade: last.attemptsMade,
          at: new Date().toISOString(),
          message: `Execution #${last.execution} on ${last.workerId} ended without an outcome; its lock expired and BullMQ returned the job to the queue`,
        });
        log.warn({ event: 'job.stall_recovered', previousWorker: last.workerId }, 'Recovering job after stall');
      }
    }

    await deps.recordHistory(jobId, {
      event: 'started',
      workerId: deps.workerId,
      execution,
      attemptsMade: job.attemptsMade,
      at: new Date().toISOString(),
    });
    log.info({ event: 'job.started' }, 'Job started');

    try {
      const result = await registry[job.name](parsed.data, {
        jobId,
        workerId: deps.workerId,
        execution,
        attemptsMade: job.attemptsMade,
        maxAttempts,
        reportProgress: async (percent) => {
          await job.updateProgress(percent);
          log.debug({ event: 'job.progress', progress: percent }, 'Progress updated');
        },
        redis: deps.redis,
        keys: deps.keys,
        logger: log,
      });
      await deps.recordHistory(jobId, {
        event: 'completed',
        workerId: deps.workerId,
        execution,
        attemptsMade: job.attemptsMade,
        at: new Date().toISOString(),
      });
      return result;
    } catch (err) {
      const errorClass = classifyError(err);
      const willRetry = errorClass === 'transient' && job.attemptsMade + 1 < maxAttempts;
      await deps.recordHistory(jobId, {
        event: 'failed',
        workerId: deps.workerId,
        execution,
        attemptsMade: job.attemptsMade,
        at: new Date().toISOString(),
        message: errorMessage(err),
        willRetry,
      });
      throw err;
    }
  };
}
