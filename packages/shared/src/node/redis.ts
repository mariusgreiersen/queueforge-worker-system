export interface ParsedRedisUrl {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db: number;
  tls: boolean;
}

export function parseRedisUrl(url: string): ParsedRedisUrl {
  const u = new URL(url);
  if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') {
    throw new Error(`Unsupported Redis URL protocol "${u.protocol}"`);
  }
  const db = u.pathname && u.pathname !== '/' ? Number(u.pathname.slice(1)) : 0;
  if (!Number.isInteger(db) || db < 0) throw new Error(`Invalid Redis database in URL: ${u.pathname}`);
  return {
    host: u.hostname || '127.0.0.1',
    port: u.port ? Number(u.port) : 6379,
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    db,
    tls: u.protocol === 'rediss:',
  };
}

/**
 * Plain connection options accepted by both ioredis and BullMQ (declared as a type alias, not an
 * interface, so it satisfies BullMQ's index-signature option type).
 */
export type ConnectionProfile = {
  host: string;
  port: number;
  db: number;
  username?: string;
  password?: string;
  tls?: Record<string, never>;
  connectionName?: string;
  connectTimeout: number;
  maxRetriesPerRequest: number | null;
  enableOfflineQueue: boolean;
  retryStrategy: (times: number) => number;
};

/**
 * Connection profiles. They differ on purpose:
 *
 * - `command` (API request path): fail fast. With the offline queue disabled and a single retry per
 *   request, a Redis outage surfaces as an error within milliseconds instead of a hung HTTP request.
 *   The client still reconnects in the background, so the API recovers on its own.
 * - `blocking` (workers, QueueEvents): BullMQ requires `maxRetriesPerRequest: null` for blocking
 *   commands. Commands are queued while disconnected and replayed after reconnecting, and the client
 *   keeps reconnecting with capped exponential backoff, so a worker survives a Redis restart.
 */
export function redisOptions(url: string, profile: 'command' | 'blocking', connectionName?: string): ConnectionProfile {
  const parsed = parseRedisUrl(url);
  const base = {
    host: parsed.host,
    port: parsed.port,
    db: parsed.db,
    ...(parsed.username ? { username: parsed.username } : {}),
    ...(parsed.password ? { password: parsed.password } : {}),
    ...(parsed.tls ? { tls: {} } : {}),
    ...(connectionName ? { connectionName } : {}),
    connectTimeout: 5_000,
  };
  if (profile === 'command') {
    return {
      ...base,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (times) => Math.min(times * 250, 5_000),
    };
  }
  return {
    ...base,
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    retryStrategy: (times) => Math.min(500 * 2 ** Math.min(times, 5), 10_000),
  };
}
