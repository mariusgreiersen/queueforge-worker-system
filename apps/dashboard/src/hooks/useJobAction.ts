import { useState } from 'react';
import { useDashboard } from '@/context/useDashboard';
import { ApiError } from '@/services/api';

/** Run a job mutation (retry/cancel), surface API errors, then refresh dashboard data. */
export function useJobAction() {
  const { refresh } = useDashboard();
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : (err as Error).message);
    }
  };
  return { run, error, clear: () => setError(null) };
}
