'use client';

import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { STEP_KEY, WIZARD_STEPS, type WizardStep } from './onboarding';

// The wizard's progress: an ordered list with the current step marked aria-current="step".
// Phase 18: the organisation and first-business set-up steps come first (`setup`); while one of
// them is current, no wizard step is (`current` null).

export type SetupState = 'done' | 'current' | 'todo';

export interface SetupProgress {
  organisation: SetupState;
  business: SetupState;
}

interface Item {
  id: string;
  label: string;
  isCurrent: boolean;
  isDone: boolean;
}

export function StepIndicator({
  current,
  completed,
  setup,
}: {
  current: WizardStep | null;
  completed: WizardStep[];
  setup?: SetupProgress;
}) {
  const t = useTranslations('onboarding');
  const f = useFormat();
  const items: Item[] = [
    ...(setup
      ? (['organisation', 'business'] as const).map((key) => ({
          id: key,
          label: t(`steps.${key}`),
          isCurrent: setup[key] === 'current',
          isDone: setup[key] === 'done',
        }))
      : []),
    ...WIZARD_STEPS.map((step) => ({
      id: step,
      label: t(`steps.${STEP_KEY[step]}`),
      isCurrent: step === current,
      isDone: completed.includes(step),
    })),
  ];
  return (
    <ol
      aria-label={t('stepIndicator.aria')}
      className={cn(
        'mb-8 grid grid-cols-2 gap-2',
        setup ? 'sm:grid-cols-3 lg:grid-cols-6' : 'sm:grid-cols-4',
      )}
    >
      {items.map((item, i) => (
        <li
          key={item.id}
          aria-current={item.isCurrent ? 'step' : undefined}
          className={cn(
            'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
            item.isCurrent
              ? 'border-foreground font-medium'
              : 'border-border text-muted-foreground',
          )}
        >
          <span
            aria-hidden
            className={cn(
              'grid size-6 shrink-0 place-items-center rounded-full text-xs tabular-nums',
              item.isDone ? 'bg-primary text-primary-foreground' : 'bg-secondary',
            )}
          >
            {item.isDone ? <Check className="size-3.5" /> : f.number(i + 1)}
          </span>
          {item.label}
          {item.isDone && <span className="sr-only"> {t('stepIndicator.done')}</span>}
        </li>
      ))}
    </ol>
  );
}
