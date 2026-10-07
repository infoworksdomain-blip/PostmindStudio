'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// Small form primitives shared by the Create, Review, Slideshow and Overlay screens: a labelled
// field. 25.3: the select these screens use is the one NativeSelect (src/components/ui).

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
