import type { ServerResponse } from 'node:http';
import type { Queue, QueueEvents } from 'bullmq';
import type { QueueEventMessage } from '@queueforge/shared';
import type { Logger } from '@queueforge/shared/node';

/** BullMQ events relayed to dashboards. Payload fields that can be large (returnvalue) are dropped. */
const RELAYED_EVENTS = [
  'added',
  'waiting',
  'active',
  'progress',
  'completed',
  'failed',
  'delayed',
  'stalled',
  'removed',
  'deduplicated',
  'retries-exhausted',
] as const;

const BUFFER_SIZE = 200;
const KEEPALIVE_MS = 15_000;

/** Redis stream ids are `<ms>-<seq>`; compare numerically, not lexicographically. */
export function compareStreamIds(a: string, b: string): number {
  const [am = 0, as = 0] = a.split('-').map(Number);
  const [bm = 0, bs = 0] = b.split('-').map(Number);
  return am - bm || as - bs;
}

/**
 * Fans BullMQ QueueEvents out to Server-Sent Event clients.
 *
 * QueueEvents tails the queue's Redis event stream, so it sees events produced by every worker
 * process, not just this API instance. Events are hints: clients treat the REST API as the source
 * of truth and refetch after (re)connecting, because events can be missed during a disconnect and
 * the stream itself is trimmed by BullMQ.
 */
export class EventHub {
  private readonly clients = new Set<ServerResponse>();
  private readonly buffer: QueueEventMessage[] = [];
  private keepalive: NodeJS.Timeout | undefined;

  constructor(
    private readonly events: QueueEvents,
    private readonly queue: Queue,
    private readonly logger: Logger,
  ) {}

  start() {
    for (const name of RELAYED_EVENTS) {
      this.events.on(name as 'added', (args: Record<string, unknown>, id: string) => {
        void this.handle(name, args, id);
      });
    }
    this.keepalive = setInterval(() => this.writeAll(': keepalive\n\n'), KEEPALIVE_MS);
    this.keepalive.unref();
  }

  private async handle(name: string, args: Record<string, unknown>, id: string) {
    const { returnvalue: _ignored, ...rest } = args;
    let event = name;
    const data: Record<string, unknown> = { ...rest };
    const jobId = typeof args.jobId === 'string' ? args.jobId : null;

    // A `delayed` event after a failed attempt means BullMQ scheduled a retry with backoff.
    if (name === 'delayed' && jobId) {
      try {
        const job = await this.queue.getJob(jobId);
        if (job && job.attemptsMade > 0) {
          event = 'retry-scheduled';
          Object.assign(data, {
            attemptsMade: job.attemptsMade,
            maxAttempts: job.opts.attempts ?? 1,
            failedReason: job.failedReason,
            jobType: job.name,
          });
        }
      } catch {
        // Enrichment is best effort.
      }
    }
    this.publish({ id, event, jobId, at: new Date(Number(id.split('-')[0]) || Date.now()).toISOString(), data });
  }

  publish(message: QueueEventMessage) {
    this.buffer.push(message);
    if (this.buffer.length > BUFFER_SIZE) this.buffer.shift();
    this.writeAll(this.format(message));
  }

  private format(m: QueueEventMessage) {
    return `id: ${m.id}\nevent: queue-event\ndata: ${JSON.stringify(m)}\n\n`;
  }

  private writeAll(chunk: string) {
    for (const res of this.clients) {
      if (!res.writableEnded) res.write(chunk);
    }
  }

  /** Attach an SSE response. Replays buffered events newer than Last-Event-ID (or the recent buffer). */
  attach(res: ServerResponse, lastEventId: string | undefined) {
    this.clients.add(res);
    res.write(`retry: 3000\n\n`);
    const replay = lastEventId
      ? this.buffer.filter((m) => compareStreamIds(m.id, lastEventId) > 0)
      : this.buffer.slice(-50);
    for (const m of replay) res.write(this.format(m));
    res.on('close', () => this.clients.delete(res));
  }

  get clientCount() {
    return this.clients.size;
  }

  /** End all streams so the HTTP server can close during shutdown. */
  closeClients() {
    if (this.keepalive) clearInterval(this.keepalive);
    for (const res of this.clients) res.end();
    this.clients.clear();
    this.logger.debug('SSE clients closed');
  }
}
