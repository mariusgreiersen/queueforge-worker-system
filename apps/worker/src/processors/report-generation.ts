import { createHash } from 'node:crypto';
import { LIMITS, type ReportGenerationData, type ReportGenerationResult } from '@queueforge/shared';
import { performOnce } from '@queueforge/shared/node';
import { progressReporter, sleep, yieldToEventLoop, type Processor } from './context';

const REGIONS = ['EMEA', 'North America', 'APAC', 'LATAM'] as const;
const CATEGORIES = ['Hardware', 'Software', 'Services', 'Support'] as const;
const PRODUCT_COUNT = 40;

export interface SalesRecord {
  id: number;
  region: string;
  category: string;
  product: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

/** FNV-1a 32-bit hash, used to derive a deterministic PRNG seed from the report name. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: small, fast, deterministic PRNG. Same seed, same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function generateRecord(id: number, rand: () => number): SalesRecord {
  const region = REGIONS[Math.floor(rand() * REGIONS.length)]!;
  const category = CATEGORIES[Math.floor(rand() * CATEGORIES.length)]!;
  const product = `P-${String(Math.floor(rand() * PRODUCT_COUNT) + 1).padStart(3, '0')}`;
  const quantity = 1 + Math.floor(rand() * 20);
  const unitPrice = round2(5 + rand() * 495);
  return { id, region, category, product, quantity, unitPrice, amount: round2(quantity * unitPrice) };
}

/** Stable report id derived from the job id, so a re-executed job writes to the same report key. */
export function reportIdFor(jobId: string): string {
  return `rpt_${createHash('sha256').update(jobId).digest('hex').slice(0, 16)}`;
}

interface Accumulator {
  count: number;
  revenue: number;
  quantity: number;
  min: number;
  max: number;
  byRegion: Map<string, { orders: number; revenue: number }>;
  byCategory: Map<string, { orders: number; revenue: number }>;
  byProduct: Map<string, number>;
}

function bump(map: Map<string, { orders: number; revenue: number }>, key: string, amount: number) {
  const entry = map.get(key) ?? { orders: 0, revenue: 0 };
  entry.orders += 1;
  entry.revenue += amount;
  map.set(key, entry);
}

function accumulate(acc: Accumulator, r: SalesRecord) {
  acc.count += 1;
  acc.revenue += r.amount;
  acc.quantity += r.quantity;
  acc.min = Math.min(acc.min, r.amount);
  acc.max = Math.max(acc.max, r.amount);
  bump(acc.byRegion, r.region, r.amount);
  bump(acc.byCategory, r.category, r.amount);
  acc.byProduct.set(r.product, (acc.byProduct.get(r.product) ?? 0) + r.amount);
}

const finalizeGroups = (map: Map<string, { orders: number; revenue: number }>) =>
  Object.fromEntries(
    [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, { orders: v.orders, revenue: round2(v.revenue) }]),
  );

export function renderCsv(byRegion: Record<string, { orders: number; revenue: number }>): string {
  const lines = ['region,orders,revenue'];
  for (const [region, v] of Object.entries(byRegion)) lines.push(`${region},${v.orders},${v.revenue.toFixed(2)}`);
  return lines.join('\n');
}

/**
 * Generates `recordCount` deterministic sales records in batches, aggregates them, and stores the
 * resulting report once (idempotently) under a report id derived from the job id.
 *
 * CPU work is chunked: after every batch the processor yields to the event loop so the worker can
 * renew its job lock. A long synchronous loop would starve lock renewal and make BullMQ consider
 * a healthy job stalled.
 */
export const reportGeneration: Processor<ReportGenerationData, ReportGenerationResult> = async (data, ctx) => {
  const started = performance.now();
  const rand = mulberry32(fnv1a(data.reportName));
  const progress = progressReporter(ctx.reportProgress);
  const acc: Accumulator = {
    count: 0,
    revenue: 0,
    quantity: 0,
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
    byRegion: new Map(),
    byCategory: new Map(),
    byProduct: new Map(),
  };

  const batchSize = LIMITS.report.batchSize;
  let batches = 0;
  for (let offset = 0; offset < data.recordCount; offset += batchSize) {
    const end = Math.min(offset + batchSize, data.recordCount);
    for (let id = offset; id < end; id++) accumulate(acc, generateRecord(id + 1, rand));
    batches += 1;
    await progress(end / data.recordCount);
    if (data.batchDelayMs > 0) await sleep(data.batchDelayMs);
    else await yieldToEventLoop();
  }

  const byRegion = finalizeGroups(acc.byRegion);
  const summary: ReportGenerationResult['summary'] = {
    totalRevenue: round2(acc.revenue),
    totalQuantity: acc.quantity,
    averageOrderValue: round2(acc.revenue / acc.count),
    minOrderValue: acc.min,
    maxOrderValue: acc.max,
    byRegion,
    byCategory: finalizeGroups(acc.byCategory),
    topProducts: [...acc.byProduct.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([product, revenue]) => ({ product, revenue: round2(revenue) })),
  };

  const reportId = reportIdFor(ctx.jobId);
  const output = data.format === 'csv' ? renderCsv(byRegion) : null;
  const stored = await performOnce(ctx.redis, ctx.keys, {
    scope: 'report',
    id: reportId,
    jobId: ctx.jobId,
    writeKey: ctx.keys.report(reportId),
    value: JSON.stringify({ reportId, reportName: data.reportName, summary, output }),
  });

  return {
    reportId,
    reportName: data.reportName,
    format: data.format,
    recordsProcessed: acc.count,
    batches,
    summary,
    output,
    durationMs: Math.round(performance.now() - started),
    stored,
  };
};
