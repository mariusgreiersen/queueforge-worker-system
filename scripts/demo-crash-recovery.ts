/**
 * npm run demo:crash-recovery
 *
 * Reproduces the flagship scenario end to end with real processes:
 *   1. starts the API and two independent workers (isolated key prefix, so it never touches your data)
 *   2. submits a long-running job through the REST API
 *   3. waits until one worker is executing it, then kills that worker with SIGKILL
 *   4. waits for BullMQ's stalled-job detection to return the job to the queue
 *   5. waits for the surviving worker to complete it, and verifies the outcome
 *
 * Requires a reachable Redis (default redis://127.0.0.1:6379, e.g. `docker compose up -d redis`).
 * Options: --redis-url <url> --duration <ms> --lock <ms> --stalled-interval <ms>
 */
import { parseArgs } from 'node:util';
import { QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_NAME, type FailureSimulationResult, type JobDetail } from '@queueforge/shared';
import { countSideEffects, metaKeys, redisOptions } from '@queueforge/shared/node';
import { spawnService, startWorkerProcess, type ManagedProcess } from './lib/harness';

const { values } = parseArgs({
  options: {
    'redis-url': { type: 'string', default: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379' },
    duration: { type: 'string', default: '10000' },
    lock: { type: 'string', default: '5000' },
    'stalled-interval': { type: 'string', default: '2500' },
  },
});
const redisUrl = values['redis-url']!;
const durationMs = Number(values.duration);
const lockDurationMs = Number(values.lock);
const stalledIntervalMs = Number(values['stalled-interval']);

const color = process.stdout.isTTY
  ? { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m', reset: '\x1b[0m' }
  : { dim: '', red: '', green: '', yellow: '', cyan: '', bold: '', reset: '' };
const t0 = Date.now();
const stamp = () => `${color.dim}+${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s${color.reset}`;
const say = (icon: string, msg: string) => console.log(`${stamp()}  ${icon}  ${msg}`);

const prefix = `qf-demo-${Date.now().toString(36)}`;
const processes: ManagedProcess[] = [];
let redis: Redis | undefined;
let events: QueueEvents | undefined;

function stop(p: ManagedProcess) {
  if (p.isRunning()) p.kill(process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
}

async function cleanup() {
  processes.forEach(stop);
  await Promise.race([Promise.all(processes.map((p) => p.exited)), new Promise((r) => setTimeout(r, 15_000))]);
  await events?.close().catch(() => undefined);
  if (redis) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 500);
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== '0');
    await redis.quit();
  }
}

/**
 * Records QueueEvents from before the job is submitted, so no event can be missed between
 * submitting and subscribing. wait() resolves with a recorded or future matching event.
 */
function recordEvents(qe: QueueEvents, names: string[]) {
  const seen: Array<{ name: string; args: Record<string, unknown>; at: number }> = [];
  const waiters = new Set<{ name: string; jobId: string; resolve: (a: Record<string, unknown>) => void }>();
  for (const name of names) {
    qe.on(name as 'completed', ((args: Record<string, unknown>) => {
      seen.push({ name, args, at: Date.now() });
      for (const w of waiters) {
        if (w.name === name && w.jobId === args.jobId) {
          waiters.delete(w);
          w.resolve(args);
        }
      }
    }) as never);
  }
  return {
    wait<T extends Record<string, unknown>>(name: string, jobId: string, timeoutMs: number, after = 0): Promise<T> {
      const hit = seen.find((e) => e.name === name && e.args.jobId === jobId && e.at >= after);
      if (hit) return Promise.resolve(hit.args as T);
      return new Promise<T>((resolve, reject) => {
        const waiter = { name, jobId, resolve: resolve as (a: Record<string, unknown>) => void };
        waiters.add(waiter);
        setTimeout(() => {
          if (waiters.delete(waiter)) reject(new Error(`no "${name}" event within ${timeoutMs} ms`));
        }, timeoutMs).unref();
      });
    },
  };
}

async function main() {
  console.log(`${color.bold}QueueForge: worker crash recovery demonstration${color.reset}`);
  console.log(
    `${color.dim}lockDuration=${lockDurationMs}ms stalledInterval=${stalledIntervalMs}ms job=${durationMs}ms prefix=${prefix}${color.reset}\n`,
  );

  const probe = new Redis({ ...redisOptions(redisUrl, 'command', 'qf-demo-probe'), lazyConnect: true, retryStrategy: () => null });
  probe.on('error', () => undefined);
  try {
    await probe.connect();
    const info = await probe.info('server');
    say('🧱', `Redis reachable at ${redisUrl} (redis_version ${/redis_version:(\S+)/.exec(info)?.[1] ?? '?'})`);
  } catch {
    console.error(`${color.red}Redis is not reachable at ${redisUrl}. Start it with: docker compose up -d redis${color.reset}`);
    process.exitCode = 1;
    return;
  } finally {
    probe.disconnect();
  }
  redis = new Redis(redisOptions(redisUrl, 'blocking', 'qf-demo'));
  const keys = metaKeys(prefix);

  events = new QueueEvents(QUEUE_NAME, { connection: redisOptions(redisUrl, 'blocking', 'qf-demo-events'), prefix });
  await events.waitUntilReady();
  const recorder = recordEvents(events, ['active', 'progress', 'stalled', 'completed', 'failed']);

  // API on an ephemeral port.
  const api = spawnService('api', 'api', { REDIS_URL: redisUrl, QUEUE_PREFIX: prefix, API_PORT: '0', API_HOST: '127.0.0.1', LOG_LEVEL: 'info' });
  processes.push(api);
  const listening = await api.waitForLog((l) => typeof l.json?.msg === 'string' && /Server listening at http:\/\/127\.0\.0\.1:\d+/.test(l.json.msg), 30_000, 'API to listen');
  const baseUrl = /http:\/\/127\.0\.0\.1:\d+/.exec(listening.json!.msg as string)![0];
  say('🌐', `API started (pid ${api.pid}) at ${baseUrl}`);

  const workerOpts = { redisUrl, prefix, concurrency: 2, lockDurationMs, stalledIntervalMs, maxStalledCount: 1 };
  const workers = new Map<string, ManagedProcess>();
  const [a, b] = await Promise.all([
    startWorkerProcess({ ...workerOpts, workerId: 'worker-a' }),
    startWorkerProcess({ ...workerOpts, workerId: 'worker-b' }),
  ]);
  workers.set('worker-a', a).set('worker-b', b);
  processes.push(a, b);
  say('⚙️ ', `Worker A started (pid ${a.pid}), Worker B started (pid ${b.pid})`);

  const res = await fetch(`${baseUrl}/api/v1/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'failure-simulation', data: { durationMs, steps: 20, label: 'crash-recovery-demo' } }),
  });
  const submitted = (await res.json()) as { jobId: string; status: string };
  say('📨', `Submitted job ${color.cyan}${submitted.jobId}${color.reset} → HTTP ${res.status}, status=${submitted.status}`);

  // First progress update: the processor is really executing (not just fetched).
  const firstProgress = await recorder.wait<{ data: number }>('progress', submitted.jobId, 30_000);
  const getJob = async () => (await (await fetch(`${baseUrl}/api/v1/jobs/${submitted.jobId}`)).json()) as JobDetail;
  const owner = (await getJob()).processedBy!;
  const victim = workers.get(owner)!;
  const survivorId = [...workers.keys()].find((w) => w !== owner)!;
  say('▶️ ', `${owner} is processing the job (progress ${firstProgress.data}%)`);

  const progressLog = (args: { jobId: string; data: unknown }) => {
    if (args.jobId === submitted.jobId && typeof args.data === 'number' && args.data % 25 === 0) say('  ', `${color.dim}progress ${args.data}%${color.reset}`);
  };
  const killedAt = Date.now();
  victim.kill('SIGKILL');
  const exit = await victim.exited;
  say('💥', `${color.red}Killed ${owner} (pid ${victim.pid}) with SIGKILL${color.reset} (exit code=${exit.code}, signal=${exit.signal})`);
  say('⏳', `Job is still "${(await getJob()).state}" in Redis. Waiting for its lock to expire and for a stalled check to notice it`);

  await recorder.wait('stalled', submitted.jobId, lockDurationMs + 4 * stalledIntervalMs + 30_000, killedAt);
  const stalledAt = Date.now();
  say('🔎', `${color.yellow}Stalled job detected by BullMQ${color.reset} ${((stalledAt - killedAt) / 1000).toFixed(2)}s after the kill → job returned to the queue`);
  events.on('progress', progressLog);

  await recorder.wait('completed', submitted.jobId, durationMs + 120_000, killedAt);
  const completedAt = Date.now();
  events.off('progress', progressLog);
  say('✅', `Job completed ${((completedAt - killedAt) / 1000).toFixed(2)}s after the kill`);

  const job = await getJob();
  const result = job.result as FailureSimulationResult | null;
  const effects = await countSideEffects(redis, keys, submitted.jobId);
  const checks: Array<[string, boolean]> = [
    ['Same job id retained (no resubmission)', job.id === submitted.jobId],
    ['Final state is completed', job.state === 'completed'],
    [`Completed by the surviving worker (${survivorId})`, result?.completedBy === survivorId && job.processedBy === survivorId],
    ['Executed twice: crashed attempt + recovery (attemptsStarted = 2)', job.attemptsStarted === 2],
    ['Stall recorded by BullMQ (stalledCounter = 1)', job.stalledCount === 1],
    ['No retry attempt consumed by the crash (attemptsMade = 1)', job.attemptsMade === 1],
    ['Result is valid (full duration, all steps)', !!result && result.steps === 20 && result.durationMs >= durationMs * 0.95],
    ['Exactly one persistent side effect', effects === 1],
    ['History shows the stall recovery', job.history.some((h) => h.event === 'stalled-recovered')],
  ];

  console.log(`\n${color.bold}Execution history (recorded by workers)${color.reset}`);
  for (const h of job.history) console.log(`  ${h.at}  ${h.event.padEnd(18)} ${h.workerId.padEnd(10)} execution #${h.execution}${h.message ? `  ${color.dim}${h.message}${color.reset}` : ''}`);

  console.log(`\n${color.bold}Checks${color.reset}`);
  for (const [label, ok] of checks) console.log(`  ${ok ? `${color.green}✔` : `${color.red}✘`}${color.reset} ${label}`);

  console.log(`\n${color.bold}Observed timings (this run)${color.reset}`);
  console.log(`  kill → stalled detected : ${((stalledAt - killedAt) / 1000).toFixed(2)} s`);
  console.log(`  kill → job completed    : ${((completedAt - killedAt) / 1000).toFixed(2)} s (includes re-running the ${durationMs / 1000}s job from the start)`);

  const passed = checks.every(([, ok]) => ok);
  console.log(`\n${passed ? `${color.green}${color.bold}PASS` : `${color.red}${color.bold}FAIL`}${color.reset}: worker crash recovery ${passed ? 'verified' : 'NOT verified'}`);
  process.exitCode = passed ? 0 : 1;
}

main()
  .catch((err) => {
    console.error(`${color.red}${color.bold}FAIL${color.reset}: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => void cleanup());
