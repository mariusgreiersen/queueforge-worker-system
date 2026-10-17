import { hostname } from 'node:os';
import type { Redis } from 'ioredis';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TTL_SECONDS, type WorkerHeartbeat } from '@queueforge/shared';
import type { Logger, MetaKeys } from '@queueforge/shared/node';
import type { WorkerConfig } from './config';

export interface WorkerStats {
  activeJobs: number;
  processed: number;
  failed: number;
}

/**
 * Publishes a heartbeat key with a short TTL. A missing or stale heartbeat suggests the worker is
 * gone, and a fresh one suggests it is alive, but neither is a guarantee: liveness of a specific
 * job is decided by BullMQ's lock, not by this key.
 */
export class Heartbeat {
  private timer: NodeJS.Timeout | undefined;
  private status: WorkerHeartbeat['status'] = 'running';
  private readonly startedAt = new Date().toISOString();

  constructor(
    private readonly redis: Redis,
    private readonly keys: MetaKeys,
    private readonly config: WorkerConfig,
    private readonly stats: () => WorkerStats,
    private readonly logger: Logger,
  ) {}

  start() {
    void this.beat();
    this.timer = setInterval(() => void this.beat(), HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
  }

  async markShuttingDown() {
    this.status = 'shutting-down';
    await this.beat();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    try {
      await this.redis.del(this.keys.heartbeat(this.config.workerId));
    } catch (err) {
      this.logger.warn({ err }, 'Could not remove heartbeat key; it will expire on its own');
    }
  }

  private async beat() {
    const payload: WorkerHeartbeat = {
      workerId: this.config.workerId,
      hostname: hostname(),
      pid: process.pid,
      concurrency: this.config.concurrency,
      startedAt: this.startedAt,
      lastHeartbeatAt: new Date().toISOString(),
      ...this.stats(),
      lockDurationMs: this.config.lockDurationMs,
      stalledIntervalMs: this.config.stalledIntervalMs,
      maxStalledCount: this.config.maxStalledCount,
      status: this.status,
    };
    try {
      await this.redis.set(this.keys.heartbeat(this.config.workerId), JSON.stringify(payload), 'EX', HEARTBEAT_TTL_SECONDS);
    } catch (err) {
      this.logger.warn({ err, event: 'worker.heartbeat_failed' }, 'Heartbeat write failed');
    }
  }
}
