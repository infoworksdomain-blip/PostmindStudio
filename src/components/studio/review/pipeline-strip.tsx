'use client';

import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

// Where the project is in the pipeline (spec 7.x states), as an ordered list of steps.

export type PipelineStep =
  'queued' | 'script' | 'shots' | 'render' | 'quality' | 'review' | 'publish';

export const PIPELINE_STEPS: Array<{ key: PipelineStep; states: string[] }> = [
  { key: 'queued', states: ['QUEUED', 'SCANNING'] },
  { key: 'script', states: ['PLANNING'] },
  { key: 'shots', states: ['ASSETS_QUEUED', 'ASSETS_GENERATING'] },
  { key: 'render', states: ['RENDERING'] },
  { key: 'quality', states: ['QUALITY_CHECKING', 'QUALITY_FAILED'] },
  { key: 'review', states: ['READY_FOR_REVIEW', 'REJECTED', 'APPROVED'] },
  { key: 'publish', states: ['PUBLISHING', 'PARTIALLY_PUBLISHED', 'PUBLISHED'] },
];

/** Index of the current step; -1 before the run starts (DRAFT) or when it failed. */
export function stepIndex(state: string): number {
  return PIPELINE_STEPS.findIndex((s) => s.states.includes(state));
}

export function PipelineStrip({ state }: { state: string }) {
  const t = useTranslations('review.pipeline');
  const current = stepIndex(state);
  const complete = state === 'PUBLISHED';
  const stalled = ['QUALITY_FAILED', 'REJECTED', 'PARTIALLY_PUBLISHED'].includes(state);
  return (
    <ol aria-label={t('aria')} className="grid grid-cols-7 gap-1 sm:gap-2">
      {PIPELINE_STEPS.map((step, i) => {
        const done = complete || i < current;
        const active = !complete && i === current;
        return (
          <li
            key={step.key}
            aria-current={active ? 'step' : undefined}
            className="flex min-w-0 flex-col gap-1.5"
          >
            <span
              className={cn(
                'h-1 rounded-full bg-border',
                done && 'bg-foreground',
                active && (stalled ? 'bg-warning' : 'animate-rec bg-primary'),
              )}
            />
            <span
              className={cn(
                'flex items-center gap-1 truncate text-[0.65rem] tracking-wide uppercase sm:text-xs',
                done || active ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {done && <Check aria-hidden className="hidden size-3 sm:block" />}
              {t(`steps.${step.key}`)}
              {done && <span className="sr-only"> {t('done')}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
