'use client';

import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

// BACKLOG 25.9 — the automation wizard's progress: "Step 2 of 5 · Cadence", a thin progress line
// and the steps as a list (done steps can be revisited; later ones wait). The current step is
// aria-current="step".

export function WizardSteps<S extends string>({
  steps,
  current,
  label,
  stepLabel,
  onGo,
}: {
  steps: readonly S[];
  current: S;
  label: string;
  stepLabel: (step: S) => string;
  onGo: (step: S) => void;
}) {
  const t = useTranslations('automations.wizard');
  const index = steps.indexOf(current);
  const pct = Math.round(((index + 1) / steps.length) * 100);
  return (
    <nav aria-label={label} className="mb-8 flex max-w-2xl flex-col gap-3">
      <p className="text-sm">
        <span className="text-muted-foreground">
          {t('stepOf', { n: index + 1, total: steps.length })}
        </span>{' '}
        <span className="font-medium">{stepLabel(current)}</span>
      </p>
      <div aria-hidden className="h-1 overflow-hidden rounded-full bg-surface-raised">
        <div
          className="h-full rounded-full bg-primary transition-[inline-size] duration-(--duration-base) ease-standard motion-reduce:transition-none"
          style={{ inlineSize: `${pct}%` }}
        />
      </div>
      <ol className="flex flex-wrap gap-1.5">
        {steps.map((s, i) => {
          const done = i < index;
          const isCurrent = s === current;
          return (
            <li key={s}>
              <button
                type="button"
                onClick={() => done && onGo(s)}
                aria-current={isCurrent ? 'step' : undefined}
                disabled={i > index}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors duration-(--duration-fast)',
                  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  isCurrent && 'bg-surface-active text-foreground',
                  done && 'text-foreground-secondary hover:bg-surface-raised hover:text-foreground',
                  i > index && 'text-muted-foreground',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'tabular grid size-4 place-items-center rounded-full text-[0.625rem]',
                    done ? 'bg-foreground text-background' : 'border border-border-strong',
                  )}
                >
                  {done ? <Check className="size-2.5" strokeWidth={3} /> : i + 1}
                </span>
                {stepLabel(s)}
                {done && <span className="sr-only">{t('stepDone')}</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
