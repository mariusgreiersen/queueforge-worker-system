import type { FailureSimulationData, FailureSimulationResult } from '@queueforge/shared';
import { performOnce } from '@queueforge/shared/node';
import { PermanentJobError, TransientJobError } from '../errors';
import { sleep, type Processor } from './context';

/**
 * Controlled failure scenarios for demonstrations and tests.
 *
 * Failures are deterministic: the first `failFirstAttempts` attempts fail, decided by BullMQ's
 * `attemptsMade` counter (failed attempts so far). A stall recovery does not increment
 * `attemptsMade`, so a job interrupted by a worker crash is re-executed as the *same* attempt.
 *
 * The waiting is timer-based on purpose: it models an I/O-bound task (calling a slow service)
 * and leaves the event loop free so lock renewal keeps working.
 */
export const failureSimulation: Processor<FailureSimulationData, FailureSimulationResult> = async (data, ctx) => {
  const started = performance.now();
  const stepMs = data.durationMs / data.steps;
  const attemptNumber = ctx.attemptsMade + 1;

  if (ctx.attemptsMade < data.failFirstAttempts) {
    // Do one step of "work" so the failure happens mid-execution, not at pick-up.
    await sleep(stepMs);
    await ctx.reportProgress(Math.floor(100 / data.steps));
    if (data.failureMode === 'permanent') {
      throw new PermanentJobError(`Simulated permanent failure on attempt ${attemptNumber}`);
    }
    throw new TransientJobError(
      `Simulated transient failure on attempt ${attemptNumber} of ${ctx.maxAttempts} (configured to fail the first ${data.failFirstAttempts})`,
    );
  }

  for (let step = 1; step <= data.steps; step++) {
    await sleep(stepMs);
    await ctx.reportProgress(Math.floor((step / data.steps) * 100));
  }

  // The job's only persistent side effect. Keyed by job id, so if this execution is a re-run
  // after a crash that happened *after* the write, the write is skipped instead of duplicated.
  const sideEffect = await performOnce(ctx.redis, ctx.keys, {
    scope: 'simulation',
    id: ctx.jobId,
    jobId: ctx.jobId,
    value: JSON.stringify({ completedBy: ctx.workerId }),
  });

  return {
    label: data.label ?? null,
    execution: ctx.execution,
    previousFailures: ctx.attemptsMade,
    completedBy: ctx.workerId,
    durationMs: Math.round(performance.now() - started),
    steps: data.steps,
    sideEffect,
  };
};
