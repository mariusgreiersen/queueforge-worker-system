import { createContext, useContext } from 'react';
import type { QueueEventMessage, QueueStats, ServerConfig, WorkersResponse } from '@queueforge/shared';
import type { StreamStatus } from '@/hooks/useEventStream';

export interface Outcome {
  at: number;
  kind: 'completed' | 'failed';
}

export interface DashboardState {
  config: ServerConfig | null;
  stats: QueueStats | null;
  statsError: string | null;
  workers: WorkersResponse | null;
  feed: QueueEventMessage[];
  /** Latest progress per job observed on the event stream (patches table rows between refetches). */
  progress: Record<string, number>;
  /** Completions/failures observed by this browser session, for the throughput chart. */
  outcomes: Outcome[];
  /** Bumped (debounced) whenever events suggest job lists are stale. Lists refetch when it changes. */
  revision: number;
  stream: StreamStatus;
  selectedJobId: string | null;
  openJob: (id: string) => void;
  closeJob: () => void;
  refresh: () => void;
  /** Subscribe to raw events (e.g. a detail panel watching one job). Returns an unsubscribe fn. */
  subscribe: (fn: (e: QueueEventMessage) => void) => () => void;
}

export const DashboardContext = createContext<DashboardState | null>(null);

export function useDashboard(): DashboardState {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error('useDashboard must be used inside DashboardProvider');
  return ctx;
}
