import type { ApiJobState } from '@queueforge/shared';
import { STATE_STYLES } from '@/lib/states';
import { cn } from '@/lib/utils';

export function StateBadge({ state, awaitingRetry, className }: { state: ApiJobState | string; awaitingRetry?: boolean; className?: string }) {
  const style = STATE_STYLES[awaitingRetry ? 'retry' : state] ?? STATE_STYLES.unknown!;
  const Icon = style.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-0.5 text-xs font-medium whitespace-nowrap text-foreground',
        className,
      )}
    >
      <Icon className={cn('size-3.5', style.tone, style.spin && 'animate-spin')} aria-hidden />
      {style.label}
    </span>
  );
}
