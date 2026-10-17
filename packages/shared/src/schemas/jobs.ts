import { z } from 'zod';
import { LIMITS, PRIORITY_LIMITS, RETRY_POLICY } from '../constants';

// ---------------------------------------------------------------------------
// Job type A — report generation
// ---------------------------------------------------------------------------

export const reportGenerationDataSchema = z.strictObject({
  reportName: z.string().trim().min(1).max(120),
  recordCount: z.int().min(1).max(LIMITS.report.maxRecords),
  format: z.enum(['json', 'csv']).default('json'),
  /**
   * Simulated I/O latency per batch (e.g. a paginated database read). Defaults to 0 so the
   * processor is pure computation; demos set it to make progress visible.
   */
  batchDelayMs: z.int().min(0).max(LIMITS.report.maxBatchDelayMs).default(0),
});
export type ReportGenerationData = z.output<typeof reportGenerationDataSchema>;

// ---------------------------------------------------------------------------
// Job type B — data transformation
// ---------------------------------------------------------------------------

const fieldName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Field names must be identifiers');

export const primitiveSchema = z.union([
  z.string().max(LIMITS.transformation.maxStringLength),
  z.number(),
  z.boolean(),
  z.null(),
]);
export type Primitive = z.output<typeof primitiveSchema>;

export const dataRecordSchema = z
  .record(fieldName, primitiveSchema)
  .refine((r) => Object.keys(r).length <= LIMITS.transformation.maxFields, {
    message: `Records may have at most ${LIMITS.transformation.maxFields} fields`,
  });
export type DataRecord = Record<string, Primitive>;

const aggregateSpecSchema = z
  .strictObject({
    field: fieldName.optional(),
    fn: z.enum(['count', 'sum', 'avg', 'min', 'max']),
    as: fieldName.optional(),
  })
  .refine((a) => a.fn === 'count' || a.field !== undefined, {
    message: 'field is required unless fn is "count"',
  });
export type AggregateSpec = z.output<typeof aggregateSpecSchema>;

export const transformationOperationSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('filter'),
    field: fieldName,
    operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in']),
    value: z.union([primitiveSchema, z.array(primitiveSchema).max(100)]),
  }),
  z.strictObject({
    op: z.literal('normalize'),
    fields: z.array(fieldName).min(1).max(20),
    mode: z.enum(['trim', 'lowercase', 'uppercase', 'min-max', 'round']),
    precision: z.int().min(0).max(10).optional(),
  }),
  z.strictObject({
    op: z.literal('dedupe'),
    fields: z.array(fieldName).min(1).max(20).optional(),
  }),
  z.strictObject({
    op: z.literal('sort'),
    field: fieldName,
    direction: z.enum(['asc', 'desc']).default('asc'),
  }),
  z.strictObject({
    op: z.literal('group'),
    by: z.array(fieldName).min(1).max(5),
    aggregates: z.array(aggregateSpecSchema).min(1).max(10),
  }),
  z.strictObject({
    op: z.literal('aggregate'),
    aggregates: z.array(aggregateSpecSchema).min(1).max(10),
  }),
]);
export type TransformationOperation = z.output<typeof transformationOperationSchema>;

export const dataTransformationDataSchema = z.strictObject({
  records: z.array(dataRecordSchema).min(1).max(LIMITS.transformation.maxRecords),
  operations: z.array(transformationOperationSchema).min(1).max(LIMITS.transformation.maxOperations),
});
export type DataTransformationData = z.output<typeof dataTransformationDataSchema>;

// ---------------------------------------------------------------------------
// Job type C — failure and recovery simulation
// ---------------------------------------------------------------------------

export const failureSimulationDataSchema = z.strictObject({
  /** Wall-clock duration of one successful attempt. Simulates an I/O-bound task (timers, not CPU). */
  durationMs: z
    .int()
    .min(LIMITS.simulation.minDurationMs)
    .max(LIMITS.simulation.maxDurationMs)
    .default(5_000),
  /** Number of progress updates emitted over the duration. */
  steps: z.int().min(1).max(LIMITS.simulation.maxSteps).default(10),
  /** Deterministically fail the first N attempts (based on BullMQ's attemptsMade counter). */
  failFirstAttempts: z.int().min(0).max(LIMITS.simulation.maxFailFirstAttempts).default(0),
  /** `transient` failures are retried with backoff; `permanent` failures skip remaining attempts. */
  failureMode: z.enum(['transient', 'permanent']).default('transient'),
  label: z.string().trim().max(120).optional(),
});
export type FailureSimulationData = z.output<typeof failureSimulationDataSchema>;

// ---------------------------------------------------------------------------
// Submission envelope
// ---------------------------------------------------------------------------

export const jobOptionsSchema = z.strictObject({
  /** 1 = highest priority. Omit for FIFO processing (prioritized jobs run after un-prioritized ones). */
  priority: z.int().min(PRIORITY_LIMITS.min).max(PRIORITY_LIMITS.max).optional(),
  /** Caller-supplied key. Scoped by job type before it is handed to BullMQ deduplication. */
  deduplicationKey: z
    .string()
    .min(1)
    .max(LIMITS.deduplicationKey.maxLength)
    .regex(/^[A-Za-z0-9._:-]+$/, 'Use letters, digits, dot, underscore, colon or dash')
    .optional(),
  /** Total processing attempts, including the first one. */
  attempts: z.int().min(RETRY_POLICY.minAttempts).max(RETRY_POLICY.maxAttempts).optional(),
  /** Initial exponential backoff delay. */
  backoffDelayMs: z
    .int()
    .min(RETRY_POLICY.minBackoffDelayMs)
    .max(RETRY_POLICY.maxBackoffDelayMs)
    .optional(),
  /** Delay before the job becomes eligible for processing. */
  delayMs: z.int().min(0).max(3_600_000).optional(),
});
export type JobOptionsInput = z.output<typeof jobOptionsSchema>;

export const submitJobSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('report-generation'),
    data: reportGenerationDataSchema,
    options: jobOptionsSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('data-transformation'),
    data: dataTransformationDataSchema,
    options: jobOptionsSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('failure-simulation'),
    data: failureSimulationDataSchema,
    options: jobOptionsSchema.optional(),
  }),
]);
export type SubmitJobInput = z.output<typeof submitJobSchema>;

export const batchSubmitSchema = z.strictObject({
  jobs: z.array(submitJobSchema).min(1).max(LIMITS.batchSubmit.maxJobs),
});
export type BatchSubmitInput = z.output<typeof batchSubmitSchema>;

/** Per-type payload schemas, used by workers to re-validate data read back from Redis. */
export const jobDataSchemas = {
  'report-generation': reportGenerationDataSchema,
  'data-transformation': dataTransformationDataSchema,
  'failure-simulation': failureSimulationDataSchema,
} as const;

export interface JobDataByType {
  'report-generation': ReportGenerationData;
  'data-transformation': DataTransformationData;
  'failure-simulation': FailureSimulationData;
}
