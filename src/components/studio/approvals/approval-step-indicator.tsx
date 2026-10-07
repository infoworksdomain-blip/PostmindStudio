'use client';

import { Check, CircleDashed, CircleX, Hourglass } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { useApprovalText } from './approval-text';
import type { ApprovalStatus } from './types';

// 15.D3 — review-screen indicator for multi-step approval workflows: "Step 1 of 2 — waiting for
// client reviewer", with the ordered steps and which are done. Renders nothing when no workflow
// applies (single-step approval) or the project is not in (or just out of) review.

const SHOWN_STATES = new Set(['READY_FOR_REVIEW', 'QUALITY_FAILED', 'APPROVED', 'REJECTED']);

interface Props {
  project: { id: string; state: string; updatedAt?: string };
}

type StepState = 'done' | 'current' | 'rejected' | 'todo';

function stepState(status: ApprovalStatus, index: number): StepState {
  if (status.outcome === 'approved' || index < status.stepIndex) return 'done';
  if (index > status.stepIndex) return 'todo';
  return status.outcome === 'rejected' ? 'rejected' : 'current';
}

const ICON: Record<StepState, typeof Check> = {
  done: Check,
  current: Hourglass,
  rejected: CircleX,
  todo: CircleDashed,
};

const TONE: Record<StepState, StatusTone> = {
  done: 'good',
  current: 'warn',
  rejected: 'bad',
  todo: 'neutral',
};

export function ApprovalStepIndicator({ project }: Props) {
  const t = useTranslations('approvals.indicator');
  const f = useFormat();
  const { describeStep, stepIndicatorText } = useApprovalText();
  const shown = SHOWN_STATES.has(project.state);
  const res = useApi<{ approval: ApprovalStatus }>(
    shown ? `/projects/${project.id}/approval` : null,
    // Refetch whenever the project changes (each approval touches updatedAt).
    { v: project.updatedAt ?? project.state },
  );
  const status = res.data?.approval;
  if (!shown || !status?.workflow) return null;
  if (!status.started && project.state !== 'READY_FOR_REVIEW') return null;
  const steps = status.workflow.steps;

  return (
    <section
      aria-label={t('regionAria')}
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium" role="status">
          {stepIndicatorText(status)}
        </p>
        <p className="text-xs text-muted-foreground">{status.workflow.name}</p>
      </div>
      <ol className="flex flex-wrap items-center gap-2">
        {steps.map((step, index) => {
          const state = stepState(status, index);
          const Icon = ICON[state];
          return (
            <li
              key={`${index}-${step.role}`}
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
              className="inline-flex"
            >
              <StatusPill
                tone={TONE[state]}
                icon={<Icon strokeWidth={1.75} aria-hidden />}
                className={cn(state === 'current' && 'font-semibold')}
              >
                <span className="tabular">{t('stepNumber', { number: f.number(index + 1) })}</span>{' '}
                {describeStep(step)}
              </StatusPill>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
