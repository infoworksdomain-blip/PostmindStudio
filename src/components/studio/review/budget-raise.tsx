'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useFormat } from '@/lib/client/format';
import type { ProjectDetail } from '@/lib/client/types';
import { useShowCosts } from '../account/use-show-costs';
import { useAction } from './use-action';

// Spec 12.5 project budget pause: generation stopped at 90% of costBudgetPence
// (errorReason `cost_cap_paused: project …`). The user raises the budget here (PATCH
// /projects/:id, allowed on FAILED) and then presses "Generate again" in the header.
// Operator decision 2026-10-04: customers never see amounts. They read that the video stopped at its
// safety limit and press one button, which raises the budget to the suggested amount; platform
// staff keep the form with figures.

const MAX_POUNDS = 100_000;

const WHOLE_POUNDS: Intl.NumberFormatOptions = {
  style: 'currency',
  currency: 'GBP',
  maximumFractionDigits: 0,
};

export function isProjectBudgetPause(project: Pick<ProjectDetail, 'state' | 'errorReason'>) {
  return (
    project.state === 'FAILED' && (project.errorReason ?? '').startsWith('cost_cap_paused: project')
  );
}

/** A suggested new budget in pence: double the current one, at least £1 more than already spent,
 *  rounded up to whole pounds. */
export function suggestedBudgetPence(
  project: Pick<ProjectDetail, 'costBudgetPence' | 'costActualPence'>,
): number {
  const current = project.costBudgetPence ?? 0;
  const pence = Math.max(current * 2, project.costActualPence + 100);
  return Math.ceil(pence / 100) * 100;
}

function suggestedPounds(project: ProjectDetail): string {
  return (suggestedBudgetPence(project) / 100).toFixed(2);
}

export function BudgetRaise({
  project,
  onChanged,
}: {
  project: ProjectDetail;
  onChanged: () => void;
}) {
  return useShowCosts() ? (
    <StaffBudgetRaise project={project} onChanged={onChanged} />
  ) : (
    <CarryOn project={project} onChanged={onChanged} />
  );
}

/** Customers: no figures, one button that raises the budget to the suggested amount. */
function CarryOn({ project, onChanged }: { project: ProjectDetail; onChanged: () => void }) {
  const t = useTranslations('review.budget');
  const ta = useTranslations('review.actions');
  const { run, busy } = useAction();

  async function carryOn() {
    const ok = await run('budget', `/projects/${project.id}`, {
      method: 'PATCH',
      body: { costBudgetPence: suggestedBudgetPence(project) },
      success: t('carriedOn', { action: ta('generateAgain') }),
    });
    if (ok) onChanged();
  }

  return (
    <section
      aria-label={t('limitAria')}
      className="flex flex-col items-start gap-2 rounded-xl border border-foreground/15 bg-card p-4"
    >
      <p className="text-sm">{t('limitReached')}</p>
      <Button loading={busy} onClick={carryOn} disabled={busy}>
        {t('carryOn')}
      </Button>
    </section>
  );
}

/** Platform staff: today's form, with what was spent and the budget. */
function StaffBudgetRaise({
  project,
  onChanged,
}: {
  project: ProjectDetail;
  onChanged: () => void;
}) {
  const t = useTranslations('review.budget');
  const ta = useTranslations('review.actions');
  const f = useFormat();
  const { run, busy } = useAction();
  const [pounds, setPounds] = useState(() => suggestedPounds(project));
  const value = Number(pounds);
  const pence = Math.round(value * 100);
  const valid =
    pounds.trim() !== '' &&
    Number.isFinite(value) &&
    value <= MAX_POUNDS &&
    pence > (project.costBudgetPence ?? 0);

  async function save() {
    const ok = await run('budget', `/projects/${project.id}`, {
      method: 'PATCH',
      body: { costBudgetPence: pence },
      success: t('raised', { amount: f.pence(pence), action: ta('generateAgain') }),
    });
    if (ok) onChanged();
  }

  return (
    <section
      aria-label={t('aria')}
      className="flex flex-col gap-2 rounded-xl border border-foreground/15 bg-card p-4"
    >
      <p className="text-sm">
        {t('paused', {
          spent: f.pence(project.costActualPence),
          budget: f.pence(project.costBudgetPence),
        })}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label
          htmlFor="raise-budget"
          className="grid gap-1 text-xs font-medium text-muted-foreground"
        >
          {t('newBudget')}
          <Input
            id="raise-budget"
            inputMode="decimal"
            className="w-32"
            value={pounds}
            onChange={(e) => setPounds(e.target.value)}
          />
        </label>
        <Button loading={busy} onClick={save} disabled={busy || !valid}>
          {t('raise')}
        </Button>
      </div>
      {!valid && pounds.trim() !== '' && (
        <p className="text-xs text-destructive">
          {t('tooLow', {
            budget: f.pence(project.costBudgetPence),
            max: f.number(MAX_POUNDS, WHOLE_POUNDS),
          })}
        </p>
      )}
    </section>
  );
}
