export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const diff = Math.max(0, now - Date.parse(iso));
  if (diff < 5_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export const formatNumber = (n: number) => new Intl.NumberFormat().format(n);

export const shortId = (id: string) => (id.startsWith('job_') ? `job_${id.slice(4, 12)}` : id);

export const JOB_TYPE_LABELS: Record<string, string> = {
  'report-generation': 'Report generation',
  'data-transformation': 'Data transformation',
  'failure-simulation': 'Failure simulation',
};
