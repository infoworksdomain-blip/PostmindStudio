'use client';

import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { STEP_KEY, WIZARD_STEPS, type WizardStep } from './onboarding';

// The wizard's progress: an ordered list with the current step marked aria-current="step".
// Phase 18: the organisation and first-business set-up steps come first (`setup`); while one of
// them is current, no wizard step is (`current` null).
// 25.6: "Step n of m" in words above a row of segments; the step names show from sm up (on a
// phone only the current one, in the line above, so the row never wraps).

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
  const index = items.findIndex((item) => item.isCurrent);
  const currentItem = index >= 0 ? items[index] : undefined;
  return (
    <div className="mb-8">
      {currentItem && (
        // The list below carries the same facts for assistive tech (aria-current, "done").
        <p aria-hidden className="mb-3 flex items-baseline gap-2 text-sm">
          <span className="font-medium tabular-nums">
            {t('stepIndicator.position', {
              current: f.number(index + 1),
              total: f.number(items.length),
            })}
          </span>
          <span className="text-foreground-secondary">{currentItem.label}</span>
        </p>
      )}
      <ol
        aria-label={t('stepIndicator.aria')}
        className={cn('grid gap-1.5', items.length > 4 ? 'grid-cols-6' : 'grid-cols-4')}
      >
        {items.map((item, i) => (
          <li
            key={item.id}
            aria-current={item.isCurrent ? 'step' : undefined}
            className="flex min-w-0 flex-col gap-2"
          >
            <span
              aria-hidden
              className={cn(
                'h-1 rounded-full transition-colors duration-(--duration-base)',
                item.isDone || item.isCurrent ? 'bg-foreground' : 'bg-surface-active',
                item.isCurrent && !item.isDone && 'bg-foreground/70',
              )}
            />
            <span
              className={cn(
                'flex min-w-0 items-center gap-1.5 text-xs',
                // Phones: names are read out, not shown (the line above shows the current one).
                'max-sm:sr-only',
                item.isCurrent
                  ? 'font-medium text-foreground'
                  : item.isDone
                    ? 'text-foreground-secondary'
                    : 'text-muted-foreground',
              )}
            >
              {item.isDone ? (
                <Check aria-hidden className="size-3.5 shrink-0" strokeWidth={2.25} />
              ) : (
                <span aria-hidden className="tabular-nums">
                  {f.number(i + 1)}
                </span>
              )}
              <span className="truncate">{item.label}</span>
              {item.isDone && <span className="sr-only"> {t('stepIndicator.done')}</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
