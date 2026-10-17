import { ArrowUpNarrowWide, Ban, CheckCircle2, CircleHelp, Clock3, Loader2, RotateCcw, Timer, XCircle, type LucideIcon } from 'lucide-react';

export interface StateStyle {
  label: string;
  icon: LucideIcon;
  /** Tailwind text colour for the icon only; labels stay in neutral ink. */
  tone: string;
  spin?: boolean;
}

export const STATE_STYLES: Record<string, StateStyle> = {
  waiting: { label: 'Waiting', icon: Clock3, tone: 'text-state-waiting' },
  prioritized: { label: 'Waiting · prioritized', icon: ArrowUpNarrowWide, tone: 'text-state-waiting' },
  active: { label: 'Active', icon: Loader2, tone: 'text-state-active', spin: true },
  delayed: { label: 'Delayed', icon: Timer, tone: 'text-state-delayed' },
  retry: { label: 'Retry scheduled', icon: RotateCcw, tone: 'text-state-delayed' },
  completed: { label: 'Completed', icon: CheckCircle2, tone: 'text-state-completed' },
  failed: { label: 'Failed', icon: XCircle, tone: 'text-state-failed' },
  cancelled: { label: 'Cancelled', icon: Ban, tone: 'text-muted-foreground' },
  unknown: { label: 'Unknown', icon: CircleHelp, tone: 'text-muted-foreground' },
  'waiting-children': { label: 'Waiting (children)', icon: Clock3, tone: 'text-state-waiting' },
};
