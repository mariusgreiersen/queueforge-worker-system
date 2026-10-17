import type { Redis } from 'ioredis';
import { METADATA_TTL_SECONDS } from '../constants';
import { executionEventSchema, type ExecutionEvent } from '../schemas/api';
import type { SideEffectRecord } from '../types';
import type { MetaKeys } from './keys';

const MAX_HISTORY_ENTRIES = 50;

/** Append an execution event to a job's QueueForge-maintained history (bounded, expiring). */
export async function appendHistory(redis: Redis, keys: MetaKeys, jobId: string, event: ExecutionEvent): Promise<void> {
  const key = keys.history(jobId);
  await redis
    .multi()
    .rpush(key, JSON.stringify(event))
    .ltrim(key, -MAX_HISTORY_ENTRIES, -1)
    .expire(key, METADATA_TTL_SECONDS)
    .exec();
}

export async function readHistory(redis: Redis, keys: MetaKeys, jobId: string): Promise<ExecutionEvent[]> {
  const raw = await redis.lrange(keys.history(jobId), 0, -1);
  const events: ExecutionEvent[] = [];
  for (const entry of raw) {
    try {
      const parsed = executionEventSchema.safeParse(JSON.parse(entry));
      if (parsed.success) events.push(parsed.data);
    } catch {
      // Ignore malformed entries rather than failing the whole job lookup.
    }
  }
  return events;
}

/**
 * Perform a side effect at most once per stable id.
 *
 * BullMQ delivers jobs at least once: a job whose worker crashes is executed again by another
 * worker. Writing the effect with SET NX keyed by an id derived from the job id makes the write
 * idempotent: the second execution finds the marker and skips the write. The audit log entry is
 * written in the same MULTI only when the marker was created, so the log counts real effects.
 *
 * This protects effects stored in this Redis. An effect in another system (an email, a payment,
 * a webhook) needs that system to accept an idempotency key, or a transactional outbox.
 */
export async function performOnce(
  redis: Redis,
  keys: MetaKeys,
  params: { scope: string; id: string; jobId: string; value: string; writeKey?: string },
): Promise<SideEffectRecord> {
  const markerKey = keys.sideEffect(params.scope, params.id);
  const created = await redis.set(markerKey, params.jobId, 'EX', METADATA_TTL_SECONDS, 'NX');
  if (created !== 'OK') return { key: markerKey, created: false };

  const multi = redis.multi();
  if (params.writeKey) multi.set(params.writeKey, params.value, 'EX', METADATA_TTL_SECONDS);
  multi
    .rpush(keys.sideEffectLog(params.jobId), JSON.stringify({ scope: params.scope, id: params.id, at: new Date().toISOString() }))
    .expire(keys.sideEffectLog(params.jobId), METADATA_TTL_SECONDS);
  await multi.exec();
  return { key: markerKey, created: true };
}

export async function countSideEffects(redis: Redis, keys: MetaKeys, jobId: string): Promise<number> {
  return redis.llen(keys.sideEffectLog(jobId));
}
