'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import type { BulkProgress, BulkResult } from './bulk-run';

// BACKLOG 25.9 — the bar above a plan's timeline for bulk actions: "Select all", how many are
// selected, the actions (the caller's buttons), and while a bulk run goes, its progress
// ("Working… 3 of 8") as a progress bar the screen reader hears through a status line.

export function PlanBulkBar({
  label,
  selectable,
  selected,
  onToggleAll,
  progress,
  children,
}: {
  label: string;
  /** How many posts can be selected (0 hides the "Select all" box). */
  selectable: number;
  selected: number;
  onToggleAll?: (all: boolean) => void;
  progress: BulkProgress | null;
  children: ReactNode;
}) {
  const t = useTranslations('plans.bulk');
  const all = selectable > 0 && selected === selectable;
  return (
    <div
      role="group"
      aria-label={label}
      className="sticky top-2 z-10 flex flex-col gap-2 rounded-panel border border-border bg-popover/95 p-3 shadow-raised backdrop-blur supports-[backdrop-filter]:bg-popover/80"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {onToggleAll && selectable > 0 && (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={all ? true : selected > 0 ? 'indeterminate' : false}
              onCheckedChange={() => onToggleAll(!all)}
              disabled={progress !== null}
            />
            {t('selectAll')}
          </label>
        )}
        <span className={cn('text-sm text-muted-foreground', selected === 0 && 'sr-only')}>
          {t('selected', { count: selected })}
        </span>
        <div className="flex flex-wrap items-center gap-2 sm:ms-auto">{children}</div>
      </div>
      {progress && (
        <Progress
          value={progress.total ? Math.round((progress.done / progress.total) * 100) : 0}
          aria-label={t('progress', { done: progress.done, total: progress.total })}
        />
      )}
      <p role="status" className={progress ? 'text-xs text-muted-foreground' : 'sr-only'}>
        {progress ? t('progress', { done: progress.done, total: progress.total }) : ''}
      </p>
    </div>
  );
}

/** The toast after a bulk run: "8 done" or "6 done, 2 could not be changed". */
export function useBulkSummary() {
  const t = useTranslations('plans.bulk');
  return <T,>(result: BulkResult<T>) =>
    result.failed.length === 0
      ? t('summaryOk', { count: result.ok.length })
      : t('summaryPartial', { ok: result.ok.length, failed: result.failed.length });
}
