import type * as React from 'react';
import { cn } from '@/lib/utils';

const control =
  'rounded-md border bg-card shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50';

export function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return <input type={type} data-slot="input" className={cn(control, 'flex h-9 w-full min-w-0 px-3 py-1 text-sm', className)} {...props} />;
}

export function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={cn(control, 'flex min-h-24 w-full px-3 py-2 font-mono text-xs', className)} {...props} />;
}

/** shadcn-style native select: a styled select element, keeping native keyboard and screen-reader behaviour. */
export function NativeSelect({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <select data-slot="native-select" className={cn(control, 'h-9 px-2.5 text-sm', className)} {...props}>
      {children}
    </select>
  );
}

export function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return <label className={cn('text-xs font-medium text-muted-foreground', className)} {...props} />;
}
