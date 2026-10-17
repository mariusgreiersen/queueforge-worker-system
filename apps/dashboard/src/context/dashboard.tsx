import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { QueueEventMessage, QueueStats, ServerConfig, WorkersResponse } from '@queueforge/shared';
import { useEventStream } from '@/hooks/useEventStream';
import { DashboardContext, type DashboardState, type Outcome } from '@/context/useDashboard';
import { api } from '@/services/api';

/** Events that are too frequent or too low-level for the human-readable feed. */
const HIDDEN_IN_FEED = new Set(['progress', 'waiting']);
const FEED_LIMIT = 150;
const OUTCOME_WINDOW_MS = 10 * 60_000;
const FALLBACK_POLL_MS = 5_000;

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [stats, setStats] = useState<QueueStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [workers, setWorkers] = useState<WorkersResponse | null>(null);
  const [feed, setFeed] = useState<QueueEventMessage[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [revision, setRevision] = useState(0);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const listeners = useRef(new Set<(e: QueueEventMessage) => void>());
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const loadStats = useCallback(
    () =>
      api
        .stats()
        .then((s) => {
          setStats(s);
          setStatsError(null);
        })
        .catch((err: Error) => setStatsError(err.message)),
    [],
  );

  // On failure keep the last known list; the stats error banner already reports API trouble.
  const loadWorkers = useCallback(() => api.workers().then(setWorkers).catch(() => undefined), []);

  const refresh = useCallback(() => {
    void loadStats();
    void loadWorkers();
    setRevision((r) => r + 1);
  }, [loadStats, loadWorkers]);

  const scheduleRefresh = useCallback(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      void loadStats();
      setRevision((r) => r + 1);
    }, 350);
  }, [loadStats]);

  const onEvent = useCallback(
    (e: QueueEventMessage) => {
      listeners.current.forEach((l) => l(e));
      if (e.event === 'progress' && e.jobId && typeof e.data.data === 'number') {
        const value = e.data.data;
        setProgress((p) => ({ ...p, [e.jobId!]: value }));
        return;
      }
      if (e.event === 'completed' || e.event === 'failed') {
        const at = Date.parse(e.at) || Date.now();
        setOutcomes((o) => [...o.filter((x) => x.at > Date.now() - OUTCOME_WINDOW_MS), { at, kind: e.event as Outcome['kind'] }]);
      }
      if (!HIDDEN_IN_FEED.has(e.event)) {
        setFeed((f) => (f.some((x) => x.id === e.id && x.event === e.event) ? f : [e, ...f].slice(0, FEED_LIMIT)));
      }
      scheduleRefresh();
    },
    [scheduleRefresh],
  );

  const stream = useEventStream(onEvent, refresh);

  useEffect(() => {
    // Initial load. The event stream's onOpen also triggers a full refresh (including job lists).
    void api.config().then(setConfig).catch(() => undefined);
    void loadStats();
    void loadWorkers();
    // Fallback polling keeps counts authoritative even if events are missed.
    const timer = setInterval(() => {
      void loadStats();
      void loadWorkers();
    }, FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [loadStats, loadWorkers]);

  const subscribe = useCallback((fn: (e: QueueEventMessage) => void) => {
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  }, []);

  const value = useMemo<DashboardState>(
    () => ({
      config,
      stats,
      statsError,
      workers,
      feed,
      progress,
      outcomes,
      revision,
      stream,
      selectedJobId,
      openJob: setSelectedJobId,
      closeJob: () => setSelectedJobId(null),
      refresh,
      subscribe,
    }),
    [config, stats, statsError, workers, feed, progress, outcomes, revision, stream, selectedJobId, refresh, subscribe],
  );

  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}
