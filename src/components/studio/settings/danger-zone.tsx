'use client';

import type { ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

// BACKLOG 25.12 — the one place for actions that cannot be taken back (transfer ownership, delete
// the organisation, delete your account, cancel the plan): an open block at the end of the page
// with an error-toned heading and a hairline, one row per action. The action itself always asks
// again in a ConfirmDialog.

export function DangerZone({
  title,
  description,
  children,
  id = 'danger-zone',
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      data-slot="danger-zone"
      className="border-t border-destructive/40 pt-6"
    >
      <h2
        id={`${id}-title`}
        className="flex items-center gap-2 text-base font-semibold tracking-tight text-destructive-foreground"
      >
        <TriangleAlert aria-hidden className="size-4 text-destructive" /> {title}
      </h2>
      {description && (
        <div className="mt-1 max-w-2xl text-sm leading-relaxed text-foreground-secondary">
          {description}
        </div>
      )}
      <div className="mt-4 divide-y divide-border">{children}</div>
    </section>
  );
}

/** One action: what it does and what happens, with its button on the end side. */
export function DangerRow({
  title,
  description,
  action,
  children,
}: {
  /** Optional when the zone holds a single action its heading already names. */
  title?: string;
  description?: ReactNode;
  action?: ReactNode;
  /** Extra controls under the text (e.g. who to transfer ownership to). */
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 py-4 first:pt-0 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="max-w-xl min-w-0 flex-1">
        {title && <h3 className="text-sm font-semibold">{title}</h3>}
        {description && (
          <div className={cn('text-sm leading-relaxed text-foreground-secondary', title && 'mt-1')}>
            {description}
          </div>
        )}
        {children}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
