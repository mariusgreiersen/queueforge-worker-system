import type { Redis } from 'ioredis';

/**
 * Minimal in-memory stand-in for the handful of Redis commands the processors' idempotency
 * helpers use (SET NX EX, RPUSH, LTRIM, EXPIRE, LLEN, LRANGE, GET, MULTI). Unit tests only;
 * everything touching BullMQ runs against real Redis in the integration suites.
 */
export function createFakeRedis() {
  const strings = new Map<string, string>();
  const lists = new Map<string, string[]>();

  const api = {
    strings,
    lists,
    async set(key: string, value: string, ...args: (string | number)[]) {
      if (args.includes('NX') && strings.has(key)) return null;
      strings.set(key, value);
      return 'OK';
    },
    async get(key: string) {
      return strings.get(key) ?? null;
    },
    async llen(key: string) {
      return lists.get(key)?.length ?? 0;
    },
    async lrange(key: string, start: number, stop: number) {
      const l = lists.get(key) ?? [];
      return l.slice(start, stop === -1 ? undefined : stop + 1);
    },
    multi() {
      const ops: Array<() => void> = [];
      const chain = {
        set(key: string, value: string) {
          ops.push(() => strings.set(key, value));
          return chain;
        },
        rpush(key: string, value: string) {
          ops.push(() => lists.set(key, [...(lists.get(key) ?? []), value]));
          return chain;
        },
        ltrim(key: string, start: number) {
          ops.push(() => lists.set(key, (lists.get(key) ?? []).slice(start)));
          return chain;
        },
        expire() {
          return chain;
        },
        async exec() {
          ops.forEach((op) => op());
          return [];
        },
      };
      return chain;
    },
  };
  return api as unknown as typeof api & Redis;
}
