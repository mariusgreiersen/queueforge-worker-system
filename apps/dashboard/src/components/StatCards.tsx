import { CheckCircle2, Clock3, Loader2, Timer, XCircle, type LucideIcon } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useDashboard } from '@/context/useDashboard';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

interface StatDef {
  key: 'pending' | 'active' | 'completed' | 'failed' | 'delayed';
  label: string;
  icon: LucideIcon;
  tone: string;
  hint: (s: NonNullable<ReturnType<typeof useDashboard>['stats']>) => string;
}

const STATS: StatDef[] = [
  { key: 'pending', label: 'Waiting jobs', icon: Clock3, tone: 'text-state-waiting', hint: (s) => `${s.counts.prioritized} prioritized` },
  { key: 'active', label: 'Active jobs', icon: Loader2, tone: 'text-state-active', hint: () => 'holding a worker lock' },
  { key: 'completed', label: 'Completed jobs', icon: CheckCircle2, tone: 'text-state-completed', hint: () => 'retained by retention policy' },
  { key: 'failed', label: 'Failed jobs', icon: XCircle, tone: 'text-state-failed', hint: () => 'attempts exhausted or permanent' },
  { key: 'delayed', label: 'Delayed jobs', icon: Timer, tone: 'text-state-delayed', hint: () => 'backoff or scheduled delay' },
];

export function StatCards() {
  const { stats } = useDashboard();
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      {STATS.map(({ key, label, icon: Icon, tone, hint }) => {
        const value = stats ? (key === 'pending' ? stats.pending : stats.counts[key]) : null;
        return (
          <div key={key} className="rounded-xl border bg-card p-4 shadow-xs">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">{label}</span>
              <Icon className={cn('size-4', tone, key === 'active' && value ? 'animate-spin' : '')} aria-hidden />
            </div>
            {value === null ? (
              <Skeleton className="mt-3 h-8 w-16" />
            ) : (
              <div className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">{formatNumber(value)}</div>
            )}
            <div className="mt-1 truncate text-[11px] text-muted-foreground">{stats ? hint(stats) : ' '}</div>
          </div>
        );
      })}
    </div>
  );
}
