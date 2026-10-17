/**
 * npm run benchmark -- [--jobs 400] [--workers 1,2,4] [--concurrency 5] [--mode io|cpu] [--redis-url url]
 *
 * For each worker count: start that many independent worker processes, enqueue N small jobs,
 * and measure until every job has *finished* (completed or failed). Accepted-but-unfinished jobs
 * are never counted. Results are printed and written to benchmarks/latest.json.
 *
 *   io  mode: failure-simulation jobs that wait --work-ms (timer-based, models I/O-bound work)
 *   cpu mode: report-generation jobs over --records generated records (real computation)
 *
 * Jobs are enqueued directly with BullMQ's addBulk so HTTP overhead is not part of the measurement.
 * Workers run with their default (info-level, structured JSON) logging, as they would in production.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, freemem, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Queue, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_NAME } from '@queueforge/shared';
import { redisOptions } from '@queueforge/shared/node';
import { repoRoot, startWorkerProcess, waitFor, type ManagedProcess } from './lib/harness';

const { values } = parseArgs({
  options: {
    jobs: { type: 'string', default: '400' },
    workers: { type: 'string', default: '1,2,4' },
    concurrency: { type: 'string', default: '5' },
    mode: { type: 'string', default: 'io' },
    'work-ms': { type: 'string', default: '100' },
    records: { type: 'string', default: '20000' },
    'redis-url': { type: 'string', default: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379' },
  },
});

const jobCount = Number(values.jobs);
const workerCounts = values.workers!.split(',').map(Number);
const concurrency = Number(values.concurrency);
const mode = values.mode === 'cpu' ? 'cpu' : 'io';
const workMs = Number(values['work-ms']);
const records = Number(values.records);
const redisUrl = values['redis-url']!;

const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0);
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

interface RunResult {
  workers: number;
  concurrencyPerWorker: number;
  jobs: number;
  completed: number;
  failed: number;
  totalDurationMs: number;
  throughputJobsPerSec: number;
  waitLatencyMs: { p50: number; p95: number; max: number };
  processingMs: { p50: number; p95: number };
  failureRate: number;
}

async function runOnce(workers: number, redis: Redis): Promise<RunResult> {
  const prefix = `qf-bench-${Date.now().toString(36)}-${workers}`;
  const queue = new Queue(QUEUE_NAME, { connection: redisOptions(redisUrl, 'blocking', 'qf-bench'), prefix });
  const procs: ManagedProcess[] = [];
  try {
    for (let i = 0; i < workers; i++) {
      procs.push(
        await startWorkerProcess({
          redisUrl,
          prefix,
          workerId: `bench-${workers}-${i + 1}`,
          concurrency,
          lockDurationMs: 30_000,
          stalledIntervalMs: 30_000,
        }),
      );
    }

    const job =
      mode === 'io'
        ? { name: 'failure-simulation', data: { durationMs: workMs, steps: 1 } }
        : { name: 'report-generation', data: { reportName: 'bench', recordCount: records, format: 'json' } };

    const started = Date.now();
    for (let offset = 0; offset < jobCount; offset += 500) {
      const n = Math.min(500, jobCount - offset);
      await queue.addBulk(Array.from({ length: n }, () => ({ ...job, opts: { attempts: 1, removeOnComplete: false } })));
    }
    await waitFor(
      async () => {
        const c = await queue.getJobCounts('completed', 'failed');
        return (c.completed ?? 0) + (c.failed ?? 0) >= jobCount;
      },
      { timeoutMs: 15 * 60_000, intervalMs: 50, description: 'all jobs to finish' },
    );

    const [completedJobs, failedJobs] = await Promise.all([queue.getJobs(['completed'], 0, -1), queue.getJobs(['failed'], 0, -1)]);
    const finished = [...completedJobs, ...failedJobs].filter(Boolean) as Job[];
    const lastFinished = Math.max(...finished.map((j) => j.finishedOn ?? 0));
    const totalDurationMs = lastFinished - started;
    const waits = finished.map((j) => (j.processedOn ?? 0) - j.timestamp).sort((a, b) => a - b);
    const proc = finished.map((j) => (j.finishedOn ?? 0) - (j.processedOn ?? 0)).sort((a, b) => a - b);
    return {
      workers,
      concurrencyPerWorker: concurrency,
      jobs: jobCount,
      completed: completedJobs.length,
      failed: failedJobs.length,
      totalDurationMs,
      throughputJobsPerSec: round(completedJobs.length / (totalDurationMs / 1000)),
      waitLatencyMs: { p50: pct(waits, 50), p95: pct(waits, 95), max: waits.at(-1) ?? 0 },
      processingMs: { p50: pct(proc, 50), p95: pct(proc, 95) },
      failureRate: round(failedJobs.length / jobCount, 4),
    };
  } finally {
    for (const p of procs) p.kill(process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
    await Promise.all(procs.map((p) => p.exited));
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 1000);
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== '0');
  }
}

async function main() {
  const redis = new Redis(redisOptions(redisUrl, 'blocking', 'qf-bench-admin'));
  const redisVersion = /redis_version:(\S+)/.exec(await redis.info('server'))?.[1] ?? 'unknown';
  const environment = {
    cpu: cpus()[0]?.model.trim() ?? 'unknown',
    logicalCores: cpus().length,
    memoryGb: round(totalmem() / 1024 ** 3),
    freeMemoryGb: round(freemem() / 1024 ** 3),
    os: `${platform()} ${release()}`,
    node: process.version,
    redisVersion,
    redisUrl: redisUrl.replace(/\/\/[^@]*@/, '//***@'),
  };
  const workload = mode === 'io' ? `failure-simulation, ${workMs} ms timer wait per job` : `report-generation, ${records} records per job`;
  console.log(`QueueForge benchmark: ${jobCount} jobs, mode=${mode} (${workload}), concurrency ${concurrency}/worker`);
  console.log(`Environment: ${JSON.stringify(environment)}\n`);

  const results: RunResult[] = [];
  for (const w of workerCounts) {
    process.stdout.write(`Running with ${w} worker process(es)... `);
    const r = await runOnce(w, redis);
    results.push(r);
    console.log(`${r.completed}/${r.jobs} completed in ${(r.totalDurationMs / 1000).toFixed(2)} s → ${r.throughputJobsPerSec} jobs/s`);
  }
  await redis.quit();

  console.log('\n| Workers | Concurrency/worker | Completed | Failed | Total time (s) | Throughput (jobs/s) | Wait p50 / p95 (ms) | Processing p50 / p95 (ms) |');
  console.log('|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of results) {
    console.log(
      `| ${r.workers} | ${r.concurrencyPerWorker} | ${r.completed} | ${r.failed} | ${(r.totalDurationMs / 1000).toFixed(2)} | ${r.throughputJobsPerSec} | ${r.waitLatencyMs.p50} / ${r.waitLatencyMs.p95} | ${r.processingMs.p50} / ${r.processingMs.p95} |`,
    );
  }

  const dir = resolve(repoRoot, 'benchmarks');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `latest-${mode}.json`);
  writeFileSync(file, JSON.stringify({ recordedAt: new Date().toISOString(), mode, workload, environment, results }, null, 2));
  console.log(`\nWritten to ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
