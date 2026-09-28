'use client';

import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { STEP_KEY, WIZARD_STEPS, type WizardStep } from './onboarding';

// The wizard's progress: an ordered list with the current step marked aria-current="step".

export function StepIndicator({
  current,
  completed,
}: {
  current: WizardStep;
  completed: WizardStep[];
}) {
  const t = useTranslations('onboarding');
  const f = useFormat();
  return (
    <ol aria-label={t('stepIndicator.aria')} className="mb-8 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {WIZARD_STEPS.map((step, i) => {
        const isCurrent = step === current;
        const isDone = completed.includes(step);
        return (
          <li
            key={step}
            aria-current={isCurrent ? 'step' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
              isCurrent ? 'border-foreground font-medium' : 'border-border text-muted-foreground',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'grid size-6 shrink-0 place-items-center rounded-full text-xs tabular-nums',
                isDone ? 'bg-primary text-primary-foreground' : 'bg-secondary',
              )}
            >
              {isDone ? <Check className="size-3.5" /> : f.number(i + 1)}
            </span>
            {t(`steps.${STEP_KEY[step]}`)}
            {isDone && <span className="sr-only"> {t('stepIndicator.done')}</span>}
          </li>
        );
      })}
    </ol>
  );
}
