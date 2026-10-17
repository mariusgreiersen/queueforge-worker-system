import type { Redis } from 'ioredis';
import type { Logger, MetaKeys } from '@queueforge/shared/node';

export interface ProcessorContext {
  jobId: string;
  workerId: string;
  /** 1-based execution number (BullMQ attemptsStarted). Increases on retries and stall recoveries. */
  execution: number;
  /** Failed attempts so far (BullMQ attemptsMade). Does not increase on stall recovery. */
  attemptsMade: number;
  maxAttempts: number;
  reportProgress: (percent: number) => Promise<void>;
  redis: Redis;
  keys: MetaKeys;
  logger: Logger;
}

export type Processor<D, R> = (data: D, ctx: ProcessorContext) => Promise<R>;

/** Yield to the event loop so BullMQ can renew job locks between chunks of CPU work. */
export const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Report progress only when the integer percentage changes, to avoid flooding Redis. */
export function progressReporter(report: (p: number) => Promise<void>) {
  let last = -1;
  return async (fraction: number) => {
    const pct = Math.max(0, Math.min(100, Math.floor(fraction * 100)));
    if (pct !== last) {
      last = pct;
      await report(pct);
    }
  };
}
