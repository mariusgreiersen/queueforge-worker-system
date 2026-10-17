import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { metaKeys, redisOptions, type Logger, type MetaKeys } from '@queueforge/shared/node';
import type { ApiConfig } from '../config';

export interface QueueClients {
  queue: Queue;
  events: QueueEvents;
  /** Command connection for QueueForge's own keys (heartbeats, history, tombstones, health). */
  redis: Redis;
  keys: MetaKeys;
  close: () => Promise<void>;
}

/**
 * The API uses three Redis connections:
 *  - Queue (fail-fast command profile) for adding and inspecting jobs,
 *  - QueueEvents (blocking profile; it tails the events stream with XREAD BLOCK),
 *  - a plain command client for QueueForge metadata.
 */
export function createQueueClients(config: ApiConfig, logger: Logger): QueueClients {
  const queue = new Queue(config.queueName, {
    connection: redisOptions(config.redisUrl, 'command', 'qf-api-queue'),
    prefix: config.prefix,
  });
  const events = new QueueEvents(config.queueName, {
    connection: redisOptions(config.redisUrl, 'blocking', 'qf-api-events'),
    prefix: config.prefix,
  });
  const redis = new Redis(redisOptions(config.redisUrl, 'command', 'qf-api-meta'));

  // Without listeners, connection errors would be thrown as unhandled 'error' events.
  let lastLogged = 0;
  const onError = (source: string) => (err: Error) => {
    const now = Date.now();
    if (now - lastLogged > 5_000) {
      lastLogged = now;
      logger.warn({ source, err: err.message, event: 'redis.error' }, 'Redis connection error');
    }
  };
  queue.on('error', onError('queue'));
  events.on('error', onError('queue-events'));
  redis.on('error', onError('meta'));

  return {
    queue,
    events,
    redis,
    keys: metaKeys(config.prefix),
    close: async () => {
      // BullMQ's close() waits for the connection to become ready, which never happens while Redis
      // is down. Bound the graceful close, then force the sockets closed.
      const graceful = Promise.allSettled([events.close(), queue.close(), redis.quit()]);
      const timedOut = await Promise.race([
        graceful.then(() => false),
        new Promise<true>((resolve) => setTimeout(() => resolve(true), 2_000).unref()),
      ]);
      if (timedOut) {
        logger.warn('Redis connections did not close gracefully within 2s; disconnecting');
        await Promise.race([
          Promise.allSettled([events.disconnect(), queue.disconnect()]),
          new Promise((resolve) => setTimeout(resolve, 1_000).unref()),
        ]);
        redis.disconnect();
      }
    },
  };
}
