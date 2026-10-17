import type { JobDataByType, JobType } from '@queueforge/shared';
import type { Processor } from './context';
import { dataTransformation } from './data-transformation';
import { failureSimulation } from './failure-simulation';
import { reportGeneration } from './report-generation';

type Registry = { [T in JobType]: Processor<JobDataByType[T], unknown> };

export const processors: Registry = {
  'report-generation': reportGeneration,
  'data-transformation': dataTransformation,
  'failure-simulation': failureSimulation,
};

export type { ProcessorContext, Processor } from './context';
