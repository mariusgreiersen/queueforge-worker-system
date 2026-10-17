/**
 * Redis keys owned by QueueForge itself (as opposed to BullMQ's `<prefix>:<queue>:*` keys).
 * Everything lives under `<prefix>:meta:` so it can be inspected or flushed independently.
 */
export function metaKeys(prefix: string) {
  const root = `${prefix}:meta`;
  return {
    heartbeat: (workerId: string) => `${root}:workers:${workerId}`,
    heartbeatPattern: `${root}:workers:*`,
    history: (jobId: string) => `${root}:history:${jobId}`,
    cancelled: (jobId: string) => `${root}:cancelled:${jobId}`,
    /** Idempotency marker for a side effect identified by a stable id. */
    sideEffect: (scope: string, id: string) => `${root}:effects:${scope}:${id}`,
    /** Append-only audit list: one entry per side effect actually performed. */
    sideEffectLog: (jobId: string) => `${root}:effects-log:${jobId}`,
    /** Stored report artifacts produced by report-generation jobs. */
    report: (reportId: string) => `${root}:reports:${reportId}`,
    /** Pub/sub channel for local-dev worker control commands (disabled unless explicitly enabled). */
    controlChannel: (workerId: string) => `${root}:control:${workerId}`,
  };
}

export type MetaKeys = ReturnType<typeof metaKeys>;
