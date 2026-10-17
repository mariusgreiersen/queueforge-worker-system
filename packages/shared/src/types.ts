import type { DataRecord, Primitive } from './schemas/jobs';

/** Result of recording a side effect through the idempotent ledger (SET NX keyed by a stable id). */
export interface SideEffectRecord {
  key: string;
  /** False when a previous execution of the same job already performed this side effect. */
  created: boolean;
}

export interface ReportGenerationResult {
  reportId: string;
  reportName: string;
  format: 'json' | 'csv';
  recordsProcessed: number;
  batches: number;
  summary: {
    totalRevenue: number;
    totalQuantity: number;
    averageOrderValue: number;
    minOrderValue: number;
    maxOrderValue: number;
    byRegion: Record<string, { orders: number; revenue: number }>;
    byCategory: Record<string, { orders: number; revenue: number }>;
    topProducts: Array<{ product: string; revenue: number }>;
  };
  /** CSV rendering of the per-region summary when format = csv. */
  output: string | null;
  /** Processing time of this execution in milliseconds. */
  durationMs: number;
  stored: SideEffectRecord;
}

export interface TransformationStep {
  op: string;
  inputCount: number;
  outputCount: number;
  durationMs: number;
}

export interface DataTransformationResult {
  records: DataRecord[];
  aggregates: Record<string, Primitive> | null;
  steps: TransformationStep[];
  inputCount: number;
  outputCount: number;
  durationMs: number;
}

export interface FailureSimulationResult {
  label: string | null;
  /** Execution number that produced this result (BullMQ attemptsStarted). */
  execution: number;
  /** Failed attempts before this successful one (BullMQ attemptsMade at start). */
  previousFailures: number;
  completedBy: string;
  durationMs: number;
  steps: number;
  sideEffect: SideEffectRecord;
}

export type JobResult = ReportGenerationResult | DataTransformationResult | FailureSimulationResult;
