/**
 * Process harness shared by the reliability tests, the crash-recovery demo and the benchmark.
 *
 * Services are spawned as real, independent Node.js processes (`node --import tsx <entry>`), so a
 * kill really terminates the process that owns the BullMQ connections and job locks. The child is
 * `node` itself rather than an `npx` or shell wrapper, so the signal reaches the worker and not a
 * wrapper process.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const ENTRYPOINTS = {
  api: resolve(repoRoot, 'apps/api/src/server.ts'),
  worker: resolve(repoRoot, 'apps/worker/src/main.ts'),
} as const;

export interface LogLine {
  raw: string;
  json: Record<string, unknown> | null;
  at: number;
}

export interface ManagedProcess {
  name: string;
  child: ChildProcess;
  pid: number;
  logs: LogLine[];
  /** Resolves with the first (past or future) log line matching the predicate. */
  waitForLog: (predicate: (line: LogLine) => boolean, timeoutMs: number, description?: string) => Promise<LogLine>;
  onLog: (listener: (line: LogLine) => void) => void;
  kill: (signal: NodeJS.Signals) => void;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  isRunning: () => boolean;
}

const live = new Set<ChildProcess>();
process.once('exit', () => {
  for (const child of live) child.kill('SIGKILL');
});

export function spawnService(kind: keyof typeof ENTRYPOINTS, name: string, env: Record<string, string>): ManagedProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRYPOINTS[kind]], {
    cwd: repoRoot,
    env: { ...process.env, LOG_PRETTY: 'false', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!child.pid) throw new Error(`Failed to spawn ${name}`);
  live.add(child);

  const logs: LogLine[] = [];
  const listeners = new Set<(line: LogLine) => void>();
  const ingest = (raw: string) => {
    if (!raw.trim()) return;
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Non-JSON output (e.g. the crash notice written to stderr).
    }
    const line = { raw, json, at: Date.now() };
    logs.push(line);
    for (const l of listeners) l(line);
  };
  createInterface({ input: child.stdout! }).on('line', ingest);
  createInterface({ input: child.stderr! }).on('line', ingest);

  let running = true;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once('exit', (code, signal) => {
      running = false;
      live.delete(child);
      resolveExit({ code, signal });
    });
  });

  return {
    name,
    child,
    pid: child.pid,
    logs,
    onLog: (listener) => listeners.add(listener),
    waitForLog: (predicate, timeoutMs, description = 'log line') =>
      new Promise<LogLine>((resolveLog, reject) => {
        const found = logs.find(predicate);
        if (found) return resolveLog(found);
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`${name}: timed out after ${timeoutMs} ms waiting for ${description}`));
        }, timeoutMs);
        const check = (line: LogLine) => {
          if (predicate(line)) {
            clearTimeout(timer);
            listeners.delete(check);
            resolveLog(line);
          }
        };
        listeners.add(check);
        void exited.then(({ code, signal }) => {
          if (listeners.has(check)) {
            clearTimeout(timer);
            listeners.delete(check);
            reject(new Error(`${name} exited (code=${code}, signal=${signal}) before ${description}`));
          }
        });
      }),
    kill: (signal) => {
      child.kill(signal);
    },
    exited,
    isRunning: () => running,
  };
}

export interface WorkerProcessOptions {
  redisUrl: string;
  prefix: string;
  workerId: string;
  concurrency?: number;
  lockDurationMs?: number;
  stalledIntervalMs?: number;
  maxStalledCount?: number;
  shutdownTimeoutMs?: number;
  logLevel?: string;
  extraEnv?: Record<string, string>;
}

/** Spawn a worker process and wait until it is connected and consuming. */
export async function startWorkerProcess(opts: WorkerProcessOptions, readyTimeoutMs = 30_000): Promise<ManagedProcess> {
  const proc = spawnService('worker', opts.workerId, {
    REDIS_URL: opts.redisUrl,
    QUEUE_PREFIX: opts.prefix,
    WORKER_ID: opts.workerId,
    WORKER_CONCURRENCY: String(opts.concurrency ?? 2),
    WORKER_LOCK_DURATION_MS: String(opts.lockDurationMs ?? 4_000),
    WORKER_STALLED_INTERVAL_MS: String(opts.stalledIntervalMs ?? 2_000),
    WORKER_MAX_STALLED_COUNT: String(opts.maxStalledCount ?? 1),
    WORKER_SHUTDOWN_TIMEOUT_MS: String(opts.shutdownTimeoutMs ?? 20_000),
    LOG_LEVEL: opts.logLevel ?? 'info',
    ...opts.extraEnv,
  });
  await proc.waitForLog((l) => l.json?.event === 'worker.started', readyTimeoutMs, 'worker.started');
  return proc;
}

/** Bounded polling helper for conditions that have no event to wait on. */
export async function waitFor<T>(
  probe: () => Promise<T | undefined | null | false>,
  { timeoutMs, intervalMs = 100, description = 'condition' }: { timeoutMs: number; intervalMs?: number; description?: string },
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
