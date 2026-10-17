import { UnrecoverableError } from 'bullmq';

/**
 * An error that retrying cannot fix (invalid input, unsupported operation). Extending BullMQ's
 * UnrecoverableError makes BullMQ move the job straight to `failed`, skipping remaining attempts.
 */
export class PermanentJobError extends UnrecoverableError {
  constructor(message: string) {
    super(message);
    this.name = 'UnrecoverableError';
  }
}

/** An error expected to succeed on a later attempt (timeouts, unavailable dependencies). */
export class TransientJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientJobError';
  }
}

export type ErrorClass = 'permanent' | 'transient';

/**
 * Classify an error thrown by a processor. Anything not explicitly permanent is treated as
 * transient: retrying an unknown error a bounded number of times is the safer default.
 */
export function classifyError(err: unknown): ErrorClass {
  if (err instanceof UnrecoverableError) return 'permanent';
  if (err instanceof Error && err.name === 'UnrecoverableError') return 'permanent';
  return 'transient';
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
