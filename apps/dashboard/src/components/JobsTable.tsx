import { useEffect, useState } from 'react';
import { Ban, ChevronLeft, ChevronRight, Eye, RotateCcw, Search } from 'lucide-react';
import type { JobSummary, ListJobsResponse } from '@queueforge/shared';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/form';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { StateBadge } from '@/components/StateBadge';
import { useDashboard } from '@/context/useDashboard';
import { formatDuration, formatRelative, JOB_TYPE_LABELS, shortId } from '@/lib/format';
import { cn } from '@/lib/utils';
import { api, ApiError } from '@/services/api';

const STATE_OPTIONS = ['all', 'waiting', 'prioritized', 'active', 'delayed', 'completed', 'failed'] as const;

export function JobRowActions({ job, onError }: { job: Pick<JobSummary, 'id' | 'state'>; onError?: (msg: string) => void }) {
  const { openJob, refresh } = useDashboard();
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      refresh();
    } catch (err) {
      onError?.(err instanceof ApiError ? `${err.code}: ${err.message}` : (err as Error).message);
    }
  };
  const cancellable = ['waiting', 'prioritized', 'delayed'].includes(job.state);
  return (
    <div className="flex items-center justify-end gap-1">
      {job.state === 'failed' && (
        <Button size="icon-sm" variant="ghost" title="Retry failed job" aria-label="Retry" onClick={() => act(() => api.retry(job.id))}>
          <RotateCcw />
        </Button>
      )}
      {cancellable && (
        <Button size="icon-sm" variant="ghost" title="Cancel (not started yet)" aria-label="Cancel" onClick={() => act(() => api.cancel(job.id))}>
          <Ban />
        </Button>
      )}
      <Button size="icon-sm" variant="ghost" title="View details" aria-label="View details" onClick={() => openJob(job.id)}>
        <Eye />
      </Button>
    </div>
  );
}

interface JobsTableProps {
  pageSize?: number;
  compact?: boolean;
  showFilters?: boolean;
}

export function JobsTable({ pageSize = 15, compact = false, showFilters = true }: JobsTableProps) {
  const { revision, progress, openJob } = useDashboard();
  const [state, setState] = useState<string>('all');
  const [type, setType] = useState<string>('');
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListJobsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listJobs({ state, type: type || undefined, sort, page, pageSize, search: search.trim() || undefined })
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setError(null);
        }
      })
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [state, type, sort, page, pageSize, search, revision]);

  // Exact id lookup: pasting a full job id opens it directly, even if it is outside the listing window.
  const onSearchSubmit = async () => {
    const q = search.trim();
    if (/^job_[0-9a-f]{32}$/.test(q) || /^[A-Za-z0-9_-]{8,100}$/.test(q)) {
      try {
        await api.getJob(q);
        openJob(q);
      } catch {
        // Not an exact id: the substring filter already applied.
      }
    }
  };

  const items = data?.items ?? [];
  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  return (
    <div className="flex flex-col gap-3">
      {showFilters && (
        <div className="flex flex-wrap items-center gap-2 px-5">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search by job ID…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              onKeyDown={(e) => e.key === 'Enter' && void onSearchSubmit()}
              aria-label="Search by job ID"
            />
          </div>
          <NativeSelect value={state} onChange={(e) => (setState(e.target.value), setPage(1))} aria-label="Filter by state">
            {STATE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s === 'all' ? 'All states' : s}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect value={type} onChange={(e) => (setType(e.target.value), setPage(1))} aria-label="Filter by type">
            <option value="">All types</option>
            {Object.entries(JOB_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect value={sort} onChange={(e) => setSort(e.target.value as 'newest' | 'oldest')} aria-label="Sort">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </NativeSelect>
        </div>
      )}

      {(error || actionError) && (
        <div className="mx-5 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error ?? actionError}
        </div>
      )}

      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-5">Job ID</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-36">Progress</TableHead>
            <TableHead>Attempts</TableHead>
            <TableHead>Created</TableHead>
            {!compact && <TableHead>Duration</TableHead>}
            <TableHead className="pr-5 text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                {data ? 'No jobs match. Submit one from the panel or the Reliability Playground.' : 'Loading…'}
              </TableCell>
            </TableRow>
          )}
          {items.map((job) => {
            const live = job.state === 'active' ? Math.max(job.progress, progress[job.id] ?? 0) : job.progress;
            return (
              <TableRow key={job.id} className="cursor-pointer" onClick={() => openJob(job.id)}>
                <TableCell className="pl-5 font-mono text-xs" title={job.id}>
                  {shortId(job.id)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{JOB_TYPE_LABELS[job.type] ?? job.type}</TableCell>
                <TableCell>
                  <StateBadge state={job.state} awaitingRetry={job.awaitingRetry} />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Progress
                      value={live}
                      className="w-20"
                      indicatorClassName={job.state === 'failed' ? 'bg-state-failed' : job.state === 'completed' ? 'bg-state-completed' : undefined}
                    />
                    <span className="w-8 text-right text-xs text-muted-foreground tabular-nums">{Math.round(live)}%</span>
                  </div>
                </TableCell>
                <TableCell className="text-xs tabular-nums">
                  <span className={cn(job.attemptsMade > 1 || job.failedReason ? 'font-semibold' : '')}>{job.attemptsMade}</span>
                  <span className="text-muted-foreground"> / {job.maxAttempts}</span>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground" title={job.createdAt}>
                  {formatRelative(job.createdAt)}
                </TableCell>
                {!compact && <TableCell className="text-xs tabular-nums">{formatDuration(job.durationMs)}</TableCell>}
                <TableCell className="pr-5" onClick={(e) => e.stopPropagation()}>
                  <JobRowActions job={job} onError={setActionError} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {showFilters && data && (
        <div className="flex items-center justify-between px-5 text-xs text-muted-foreground">
          <span>
            {data.total} job{data.total === 1 ? '' : 's'}
            {!data.exact && ' (scanned the most recent jobs per state)'}
          </span>
          <div className="flex items-center gap-2">
            <Button size="icon-sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
              <ChevronLeft />
            </Button>
            <span className="tabular-nums">
              Page {page} of {totalPages}
            </span>
            <Button size="icon-sm" variant="outline" disabled={!data.hasMore} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
