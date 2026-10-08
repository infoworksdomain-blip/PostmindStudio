'use client';

import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { changeDirection, type PeriodChange } from './analytics-model';

// BACKLOG 25.11 — "▲ 12% vs the previous 30 days". Direction is said in words and an arrow as
// well as colour (text tones from the status tokens, ≥4.5:1), so it never relies on colour alone.
// Nothing is shown when there was no previous activity to compare with.

const TONE = {
  up: 'text-success-foreground',
  down: 'text-destructive-foreground',
  flat: 'text-muted-foreground',
} as const;

const ICON = { up: ArrowUpRight, down: ArrowDownRight, flat: ArrowRight } as const;

export function ChangeBadge({
  change,
  days,
  className,
}: {
  change: PeriodChange | null;
  days: number;
  className?: string;
}) {
  const t = useTranslations('analytics.change');
  const f = useFormat();
  if (!change || change.change === null) return null;
  const direction = changeDirection(change.change);
  const Icon = ICON[direction];
  const pct = f.percent(Math.abs(change.change), Math.abs(change.change) < 0.1 ? 1 : 0);
  return (
    <span
      data-direction={direction}
      className={cn(
        'inline-flex items-center gap-1 text-xs font-medium',
        TONE[direction],
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5 rtl:-scale-x-100" />
      <span>
        {t.rich(direction, {
          pct,
          days,
          n: (chunks) => <span className="font-mono">{chunks}</span>,
        })}
      </span>
    </span>
  );
}
