import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

// A styled native <select>: filters need nothing more, and it stays keyboard- and
// screen-reader-friendly on phones without a custom popover.

export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'h-8 rounded-lg border border-input bg-background px-2.5 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
        className,
      )}
      {...props}
    />
  );
}
