'use client';

import { AlertTriangle, Check, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ProjectDetail } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import { pipelineView, type StepStatus } from './pipeline-model';

// Where the project is in the pipeline, step by step: done, working now, waiting on a person,
// failed (the step a stopped run stopped at), or not reached. A draft says how to begin.

export { PIPELINE_STEPS, stepIndex, type PipelineStep } from './pipeline-model';

const BAR: Record<StepStatus, string> = {
  done: 'bg-foreground',
  current: 'bg-primary motion-safe:animate-rec',
  attention: 'bg-warning',
  failed: 'bg-destructive',
  todo: 'bg-border',
};

export function PipelineStrip({
  project,
}: {
  project: Pick<ProjectDetail, 'state' | 'errorReason' | 'scripts' | 'renders'>;
}) {
  const t = useTranslations('review.pipeline');
  const view = pipelineView(project);
  return (
    <div className="flex flex-col gap-2">
      <ol aria-label={t('aria')} className="grid grid-cols-7 gap-1 sm:gap-1.5">
        {view.steps.map((step) => {
          const reached = step.status !== 'todo';
          return (
            <li
              key={step.key}
              data-status={step.status}
              aria-current={
                step.status === 'current' || step.status === 'attention' ? 'step' : undefined
              }
              className="flex min-w-0 flex-col gap-1.5"
            >
              <span aria-hidden className={cn('h-1 rounded-full', BAR[step.status])} />
              <span
                className={cn(
                  'flex items-center gap-1 truncate text-[0.65rem] tracking-wide uppercase',
                  reached ? 'text-foreground' : 'text-muted-foreground',
                  step.status === 'failed' && 'font-medium text-destructive',
                )}
              >
                {step.status === 'done' && (
                  <Check aria-hidden className="hidden size-3 shrink-0 sm:block" />
                )}
                {step.status === 'failed' && <X aria-hidden className="size-3 shrink-0" />}
                {step.status === 'attention' && (
                  <AlertTriangle aria-hidden className="hidden size-3 shrink-0 sm:block" />
                )}
                <span className="truncate">{t(`steps.${step.key}`)}</span>
                {step.status === 'done' && <span className="sr-only"> {t('done')}</span>}
                {step.status === 'failed' && <span className="sr-only"> {t('failedMark')}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      {view.phase === 'draft' && <p className="text-xs text-muted-foreground">{t('notStarted')}</p>}
      {view.phase === 'failed' && view.failedStep && (
        <p className="text-xs text-destructive">
          {t('stoppedAt', { step: t(`steps.${view.failedStep}`) })}
        </p>
      )}
    </div>
  );
}
