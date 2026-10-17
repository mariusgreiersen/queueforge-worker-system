import { useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { STATE_STYLES } from '@/lib/states';
import { useDashboard } from '@/context/useDashboard';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

const DISTRIBUTION = [
  { key: 'pending', label: 'Waiting', color: 'var(--state-waiting)', style: STATE_STYLES.waiting! },
  { key: 'active', label: 'Active', color: 'var(--state-active)', style: STATE_STYLES.active! },
  { key: 'delayed', label: 'Delayed', color: 'var(--state-delayed)', style: STATE_STYLES.delayed! },
  { key: 'completed', label: 'Completed', color: 'var(--state-completed)', style: STATE_STYLES.completed! },
  { key: 'failed', label: 'Failed', color: 'var(--state-failed)', style: STATE_STYLES.failed! },
] as const;

/**
 * Job status distribution as a directly-labelled bar list: each row carries icon + label + value,
 * so state is never encoded by colour alone, and lengths are compared on a shared scale.
 */
export function StateDistribution() {
  const { stats } = useDashboard();
  const rows = DISTRIBUTION.map((d) => ({
    ...d,
    value: stats ? (d.key === 'pending' ? stats.pending : stats.counts[d.key]) : 0,
  }));
  const total = rows.reduce((n, r) => n + r.value, 0);
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <Card className="h-full">
      <CardHeader>
        <div>
          <CardTitle>Job status distribution</CardTitle>
          <CardDescription>Live BullMQ counts · {formatNumber(total)} jobs retained in Redis</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3.5">
        {rows.map(({ key, label, color, style, value }) => {
          const Icon = style.icon;
          return (
            <div key={key} className="group" title={`${label}: ${value} (${total ? Math.round((value / total) * 100) : 0}%)`}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 font-medium">
                  <Icon className={cn('size-3.5', style.tone)} aria-hidden />
                  {label}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {formatNumber(value)}
                  <span className="ml-1.5 text-[11px]">{total ? `${Math.round((value / total) * 100)}%` : ''}</span>
                </span>
              </div>
              <div className="h-2 w-full rounded-full bg-secondary">
                <div
                  className="h-2 rounded-full transition-[width] duration-500 group-hover:opacity-85"
                  style={{ width: `${(value / max) * 100}%`, minWidth: value ? 4 : 0, background: color }}
                />
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

const BUCKET_MS = 10_000;
const BUCKETS = 30; // last 5 minutes

interface TooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: ReadonlyArray<{ dataKey?: unknown; name?: unknown; value?: unknown; color?: string }>;
}

function OutcomeTooltip({ active, payload, label }: TooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-medium">{label}</div>
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center gap-2">
          <span className="size-2 rounded-sm" style={{ background: String(p.color) }} />
          <span className="text-muted-foreground">{String(p.name)}</span>
          <span className="ml-auto pl-3 font-medium tabular-nums">{String(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Completions and failures per 10 s, built only from events this browser session has observed
 * (BullMQ keeps no throughput history unless metrics are enabled). Labelled as such in the UI.
 */
export function ThroughputChart() {
  const { outcomes } = useDashboard();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 2_000);
    return () => clearInterval(t);
  }, []);

  const data = useMemo(() => {
    const end = Math.ceil(now / BUCKET_MS) * BUCKET_MS;
    return Array.from({ length: BUCKETS }, (_, i) => {
      const from = end - (BUCKETS - i) * BUCKET_MS;
      const inBucket = outcomes.filter((o) => o.at >= from && o.at < from + BUCKET_MS);
      return {
        label: new Date(from).toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' }),
        completed: inBucket.filter((o) => o.kind === 'completed').length,
        failed: inBucket.filter((o) => o.kind === 'failed').length,
      };
    });
  }, [outcomes, now]);
  const total = outcomes.filter((o) => o.at > now - BUCKETS * BUCKET_MS);

  return (
    <Card className="h-full">
      <CardHeader>
        <div>
          <CardTitle>Processing activity</CardTitle>
          <CardDescription>Jobs finished per 10 s · observed by this session over the last 5 min</CardDescription>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-state-completed" /> Completed{' '}
            <span className="font-medium text-foreground tabular-nums">{total.filter((o) => o.kind === 'completed').length}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-state-failed" /> Failed{' '}
            <span className="font-medium text-foreground tabular-nums">{total.filter((o) => o.kind === 'failed').length}</span>
          </span>
        </div>
      </CardHeader>
      <CardContent className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -24 }} barCategoryGap={2}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              interval={5}
              tick={{ fontSize: 11, fill: 'var(--chart-axis)' }}
            />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'var(--chart-axis)' }} />
            <Tooltip content={(props) => <OutcomeTooltip {...(props as TooltipProps)} />} cursor={{ fill: 'var(--chart-grid)', opacity: 0.6 }} />
            <Bar dataKey="completed" name="Completed" stackId="o" fill="var(--state-completed)" stroke="var(--card)" strokeWidth={1} maxBarSize={18} />
            <Bar dataKey="failed" name="Failed" stackId="o" fill="var(--state-failed)" stroke="var(--card)" strokeWidth={1} radius={[4, 4, 0, 0]} maxBarSize={18} />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
