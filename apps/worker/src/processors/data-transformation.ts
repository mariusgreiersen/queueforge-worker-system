import type {
  AggregateSpec,
  DataRecord,
  DataTransformationData,
  DataTransformationResult,
  Primitive,
  TransformationOperation,
  TransformationStep,
} from '@queueforge/shared';
import { PermanentJobError } from '../errors';
import { yieldToEventLoop, type Processor } from './context';

type FilterOp = Extract<TransformationOperation, { op: 'filter' }>;
type NormalizeOp = Extract<TransformationOperation, { op: 'normalize' }>;

const isNumber = (v: Primitive | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

function compare(a: Primitive | undefined, b: Primitive | undefined): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1; // nulls last
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function matches(record: DataRecord, f: FilterOp): boolean {
  const v = record[f.field];
  switch (f.operator) {
    case 'eq':
      return v === f.value;
    case 'neq':
      return v !== f.value;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (Array.isArray(f.value)) throw new PermanentJobError(`filter ${f.operator} expects a single value`);
      const comparable =
        (typeof v === 'number' && typeof f.value === 'number') || (typeof v === 'string' && typeof f.value === 'string');
      if (!comparable) return false;
      const c = compare(v, f.value);
      return f.operator === 'gt' ? c > 0 : f.operator === 'gte' ? c >= 0 : f.operator === 'lt' ? c < 0 : c <= 0;
    }
    case 'contains':
      if (typeof f.value !== 'string') throw new PermanentJobError('filter contains expects a string value');
      return typeof v === 'string' && v.includes(f.value);
    case 'in':
      if (!Array.isArray(f.value)) throw new PermanentJobError('filter in expects an array value');
      return (f.value as Primitive[]).includes(v ?? null);
  }
}

function normalize(records: DataRecord[], op: NormalizeOp): DataRecord[] {
  if (op.mode === 'min-max') {
    const ranges = new Map<string, { min: number; max: number }>();
    for (const field of op.fields) {
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (const r of records) {
        const v = r[field];
        if (v === null || v === undefined) continue;
        if (!isNumber(v)) throw new PermanentJobError(`normalize min-max: field "${field}" contains a non-numeric value`);
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      ranges.set(field, { min, max });
    }
    return records.map((r) => {
      const out = { ...r };
      for (const [field, { min, max }] of ranges) {
        const v = out[field];
        if (isNumber(v)) out[field] = max === min ? 0 : (v - min) / (max - min);
      }
      return out;
    });
  }
  return records.map((r) => {
    const out = { ...r };
    for (const field of op.fields) {
      const v = out[field];
      if (op.mode === 'round') {
        if (isNumber(v)) {
          const f = 10 ** (op.precision ?? 0);
          out[field] = Math.round(v * f) / f;
        }
      } else if (typeof v === 'string') {
        out[field] = op.mode === 'trim' ? v.trim() : op.mode === 'lowercase' ? v.toLowerCase() : v.toUpperCase();
      }
    }
    return out;
  });
}

function aggregateName(spec: AggregateSpec): string {
  return spec.as ?? (spec.field ? `${spec.fn}_${spec.field}` : spec.fn);
}

export function computeAggregate(rows: DataRecord[], spec: AggregateSpec): Primitive {
  if (spec.fn === 'count') {
    return spec.field ? rows.filter((r) => r[spec.field!] !== null && r[spec.field!] !== undefined).length : rows.length;
  }
  const values = rows.map((r) => r[spec.field!]).filter(isNumber);
  if (values.length === 0) return null;
  switch (spec.fn) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
  }
}

function dedupe(records: DataRecord[], fields?: string[]): DataRecord[] {
  const seen = new Set<string>();
  const out: DataRecord[] = [];
  for (const r of records) {
    const key = fields
      ? JSON.stringify(fields.map((f) => r[f] ?? null))
      : JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]));
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

function group(records: DataRecord[], by: string[], aggregates: AggregateSpec[]): DataRecord[] {
  const groups = new Map<string, DataRecord[]>();
  for (const r of records) {
    const key = JSON.stringify(by.map((f) => r[f] ?? null));
    const bucket = groups.get(key);
    if (bucket) bucket.push(r);
    else groups.set(key, [r]);
  }
  const out: DataRecord[] = [];
  for (const [key, rows] of groups) {
    const values = JSON.parse(key) as Primitive[];
    const row: DataRecord = {};
    by.forEach((f, i) => (row[f] = values[i] ?? null));
    for (const spec of aggregates) row[aggregateName(spec)] = computeAggregate(rows, spec);
    out.push(row);
  }
  return out;
}

/**
 * Runs the operation pipeline in order. Pure apart from yielding to the event loop between
 * operations, so the same input always produces the same output (safe to re-execute).
 */
export async function runTransformations(
  data: DataTransformationData,
  onStep?: (completed: number, total: number) => Promise<void>,
): Promise<Omit<DataTransformationResult, 'durationMs'>> {
  let records: DataRecord[] = data.records;
  let aggregates: Record<string, Primitive> | null = null;
  const steps: TransformationStep[] = [];

  for (const [index, op] of data.operations.entries()) {
    const t0 = performance.now();
    const inputCount = records.length;
    switch (op.op) {
      case 'filter':
        records = records.filter((r) => matches(r, op));
        break;
      case 'normalize':
        records = normalize(records, op);
        break;
      case 'dedupe':
        records = dedupe(records, op.fields);
        break;
      case 'sort': {
        const dir = op.direction === 'desc' ? -1 : 1;
        records = [...records].sort((a, b) => dir * compare(a[op.field], b[op.field]));
        break;
      }
      case 'group':
        records = group(records, op.by, op.aggregates);
        break;
      case 'aggregate':
        {
          const next: Record<string, Primitive> = { ...(aggregates ?? {}) };
          for (const spec of op.aggregates) next[aggregateName(spec)] = computeAggregate(records, spec);
          aggregates = next;
        }
        break;
    }
    steps.push({
      op: op.op,
      inputCount,
      outputCount: records.length,
      durationMs: Math.round((performance.now() - t0) * 1000) / 1000,
    });
    await onStep?.(index + 1, data.operations.length);
    await yieldToEventLoop();
  }

  return { records, aggregates, steps, inputCount: data.records.length, outputCount: records.length };
}

export const dataTransformation: Processor<DataTransformationData, DataTransformationResult> = async (data, ctx) => {
  const started = performance.now();
  const result = await runTransformations(data, (done, total) => ctx.reportProgress(Math.floor((done / total) * 100)));
  return { ...result, durationMs: Math.round(performance.now() - started) };
};
