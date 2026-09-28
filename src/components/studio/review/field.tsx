'use client';

import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

// Small form primitives shared by the Create, Review, Slideshow and Overlay screens. A native
// <select> is used deliberately: it is keyboard- and screen-reader-friendly on every device and
// behaves predictably at 375px.

export const CONTROL =
  'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30';

export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn(CONTROL, 'pe-8', className)} {...props} />;
}

export function Field({
  id,
  label,
  hint,
  children,
  className,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
