import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { STEP_LABEL, WIZARD_STEPS, type WizardStep } from './onboarding';

// The wizard's progress: an ordered list with the current step marked aria-current="step".

export function StepIndicator({
  current,
  completed,
}: {
  current: WizardStep;
  completed: WizardStep[];
}) {
  return (
    <ol aria-label="Setup progress" className="mb-8 grid grid-cols-2 gap-2 sm:grid-cols-4">
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
              {isDone ? <Check className="size-3.5" /> : i + 1}
            </span>
            {STEP_LABEL[step]}
            {isDone && <span className="sr-only"> (done)</span>}
          </li>
        );
      })}
    </ol>
  );
}
