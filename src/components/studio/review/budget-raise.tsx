'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatPence } from '@/lib/client/format';
import type { ProjectDetail } from '@/lib/client/types';
import { useAction } from './use-action';

// Spec 12.5 project budget pause: generation stopped at 90% of costBudgetPence
// (errorReason `cost_cap_paused: project …`). The user raises the budget here (PATCH
// /projects/:id, allowed on FAILED) and then presses "Generate again" in the header.

const MAX_POUNDS = 100_000;

export function isProjectBudgetPause(project: Pick<ProjectDetail, 'state' | 'errorReason'>) {
  return (
    project.state === 'FAILED' && (project.errorReason ?? '').startsWith('cost_cap_paused: project')
  );
}

/** A suggested new budget: double the current one, at least £1 more than already spent. */
function suggestedPounds(project: ProjectDetail): string {
  const current = project.costBudgetPence ?? 0;
  const pence = Math.max(current * 2, project.costActualPence + 100);
  return ((Math.ceil(pence / 100) * 100) / 100).toFixed(2);
}

export function BudgetRaise({
  project,
  onChanged,
}: {
  project: ProjectDetail;
  onChanged: () => void;
}) {
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
      success: `Budget raised to ${formatPence(pence)}. Press “Generate again” to continue.`,
    });
    if (ok) onChanged();
  }

  return (
    <section
      aria-label="Raise budget"
      className="flex flex-col gap-2 rounded-xl border border-foreground/15 bg-card p-4"
    >
      <p className="text-sm">
        Generation paused at 90% of this project&apos;s budget (
        {formatPence(project.costActualPence)} of {formatPence(project.costBudgetPence)} spent).
        Raise the budget, then generate again. Nothing already made is lost.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label
          htmlFor="raise-budget"
          className="grid gap-1 text-xs font-medium text-muted-foreground"
        >
          New budget (£)
          <Input
            id="raise-budget"
            inputMode="decimal"
            className="w-32"
            value={pounds}
            onChange={(e) => setPounds(e.target.value)}
          />
        </label>
        <Button onClick={save} disabled={busy || !valid}>
          {busy && <Loader2 className="animate-spin" />} Raise budget
        </Button>
      </div>
      {!valid && pounds.trim() !== '' && (
        <p className="text-xs text-destructive">
          Enter more than {formatPence(project.costBudgetPence)} (up to £100,000).
        </p>
      )}
    </section>
  );
}
