'use client';

import { useId, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import {
  parseList,
  SUGGESTED_ROLES,
  WORKFLOW_PLATFORMS,
  type ApprovalWorkflow,
  type WorkflowInput,
  type WorkflowStep,
} from './types';

// 15.D3 — create / edit one approval workflow: a name, ordered steps (membership role + how many
// people of that role must approve) and which projects it applies to (businesses, platforms,
// tags; all empty = every project). Validation mirrors the API's zod schema.

const MAX_STEPS = 10;
const MAX_APPROVERS = 10;
const ROLE = /^[a-z][a-z0-9_:-]{0,63}$/;

interface Props {
  initial?: ApprovalWorkflow;
  /** The organisation's businesses, offered as a picker (the stored value is each one's id). */
  businesses: ReadonlyArray<{ id: string; name: string }>;
  saving: boolean;
  onSubmit: (input: WorkflowInput) => void;
  onCancel: () => void;
}

/** A validation problem; the message is `approvals.problems.<code>` in the catalogue. */
export type WorkflowProblem =
  | { code: 'name' | 'noSteps' }
  | { code: 'role' | 'minApprovers'; step: number }
  | { code: 'maxApprovers'; step: number; max: number };

export function validateWorkflow(input: WorkflowInput): WorkflowProblem | null {
  if (!input.name.trim()) return { code: 'name' };
  if (input.steps.length === 0) return { code: 'noSteps' };
  for (const [i, step] of input.steps.entries()) {
    if (!ROLE.test(step.role)) return { code: 'role', step: i + 1 };
    if (!Number.isInteger(step.minApprovers) || step.minApprovers < 1)
      return { code: 'minApprovers', step: i + 1 };
    if (step.minApprovers > MAX_APPROVERS)
      return { code: 'maxApprovers', step: i + 1, max: MAX_APPROVERS };
  }
  return null;
}

function useProblemMessage(): (problem: WorkflowProblem) => string {
  const t = useTranslations('approvals.problems');
  const f = useFormat();
  return (problem) => {
    switch (problem.code) {
      case 'name':
      case 'noSteps':
        return t(problem.code);
      case 'role':
      case 'minApprovers':
        return t(problem.code, { step: f.number(problem.step) });
      case 'maxApprovers':
        return t('maxApprovers', { step: f.number(problem.step), max: f.number(problem.max) });
    }
  };
}

function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

function StepRow({
  index,
  step,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  step: WorkflowStep;
  count: number;
  onChange: (step: WorkflowStep) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const t = useTranslations('approvals.form');
  const f = useFormat();
  const id = useId();
  const number = f.number(index + 1);
  return (
    <li className="grid grid-cols-[auto_1fr] items-end gap-x-3 gap-y-2 rounded-lg border border-border bg-background p-3 sm:grid-cols-[auto_1fr_7rem_auto]">
      <span className="font-display row-span-2 self-center text-2xl text-muted-foreground tabular sm:row-span-1">
        {number}
      </span>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-role`}>{t('role')}</Label>
        <Input
          id={`${id}-role`}
          list={`${id}-roles`}
          value={step.role}
          onChange={(e) => onChange({ ...step, role: e.target.value.trim().toLowerCase() })}
        />
        <datalist id={`${id}-roles`}>
          {[...SUGGESTED_ROLES, 'publisher'].map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-min`}>{t('approvers')}</Label>
        <Input
          id={`${id}-min`}
          type="number"
          min={1}
          max={MAX_APPROVERS}
          value={step.minApprovers}
          onChange={(e) => onChange({ ...step, minApprovers: Number(e.target.value) })}
        />
      </div>
      <div className="col-start-2 flex gap-1 sm:col-start-auto">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('moveUp', { number })}
          disabled={index === 0}
          onClick={() => onMove(index - 1)}
        >
          <ArrowUp />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('moveDown', { number })}
          disabled={index === count - 1}
          onClick={() => onMove(index + 1)}
        >
          <ArrowDown />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('removeStep', { number })}
          disabled={count === 1}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>
    </li>
  );
}

export function WorkflowForm({ initial, businesses, saving, onSubmit, onCancel }: Props) {
  const t = useTranslations('approvals.form');
  const tc = useTranslations('common.actions');
  const tApplies = useTranslations('approvals.appliesTo');
  const f = useFormat();
  const problemMessage = useProblemMessage();
  const id = useId();
  const [name, setName] = useState(initial?.name ?? '');
  const [steps, setSteps] = useState<WorkflowStep[]>(
    initial?.steps ?? [{ role: 'admin', minApprovers: 1 }],
  );
  const [businessIds, setBusinessIds] = useState<string[]>(initial?.appliesTo.businessIds ?? []);
  const [tags, setTags] = useState(initial?.appliesTo.tags.join(', ') ?? '');
  const [platforms, setPlatforms] = useState<string[]>(initial?.appliesTo.platforms ?? []);
  const [problem, setProblem] = useState<WorkflowProblem | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const input: WorkflowInput = {
      name: name.trim(),
      steps,
      appliesTo: {
        businessIds,
        platforms,
        tags: parseList(tags).map((t) => t.toLowerCase()),
      },
    };
    const invalid = validateWorkflow(input);
    setProblem(invalid);
    if (!invalid) onSubmit(input);
  };

  const toggleBusiness = (businessId: string) =>
    setBusinessIds((cur) =>
      cur.includes(businessId) ? cur.filter((x) => x !== businessId) : [...cur, businessId],
    );
  // A saved id the list no longer holds (a deleted business) stays visible, as "a removed business"
  // (never its raw id), so it can be unselected.
  const knownIds = new Set(businesses.map((b) => b.id));
  const businessChoices = [
    ...businesses,
    ...businessIds
      .filter((b) => !knownIds.has(b))
      .map((b) => ({ id: b, name: tApplies('removedBusiness') })),
  ];
  const togglePlatform = (p: string) =>
    setPlatforms((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  return (
    <form
      onSubmit={submit}
      aria-label={initial ? t('editAria', { name: initial.name }) : t('newAria')}
      className="flex flex-col gap-5"
      noValidate
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-name`}>{t('name')}</Label>
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={120}
          placeholder={t('namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t('steps')}</legend>
        <p className="text-xs text-muted-foreground">{t('stepsHelp')}</p>
        <ol className="flex flex-col gap-2">
          {steps.map((step, index) => (
            <StepRow
              key={index}
              index={index}
              step={step}
              count={steps.length}
              onChange={(s) => setSteps((cur) => cur.map((x, i) => (i === index ? s : x)))}
              onMove={(to) => setSteps((cur) => move(cur, index, to))}
              onRemove={() => setSteps((cur) => cur.filter((_, i) => i !== index))}
            />
          ))}
        </ol>
        <Button
          type="button"
          variant="outline"
          className="self-start"
          disabled={steps.length >= MAX_STEPS}
          onClick={() => setSteps((cur) => [...cur, { role: 'publisher', minApprovers: 1 }])}
        >
          <Plus /> {t('addStep')}
        </Button>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-medium">{t('appliesTo')}</legend>
        <p className="text-xs text-muted-foreground">{t('appliesToHelp')}</p>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm" id={`${id}-businesses`}>
            {t('businesses')}
          </span>
          {businessChoices.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('noBusinesses')}</p>
          ) : (
            <div
              role="group"
              aria-labelledby={`${id}-businesses`}
              className="flex flex-wrap gap-1.5"
            >
              {businessChoices.map((b) => {
                const on = businessIds.includes(b.id);
                return (
                  <button
                    key={b.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleBusiness(b.id)}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                      on
                        ? 'border-foreground bg-foreground text-background'
                        : 'border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground',
                    )}
                  >
                    {b.name}
                  </button>
                );
              })}
            </div>
          )}
          <p className="text-xs text-muted-foreground">{t('businessesHelp')}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm" id={`${id}-platforms`}>
            {t('platforms')}
          </span>
          <div role="group" aria-labelledby={`${id}-platforms`} className="flex flex-wrap gap-1.5">
            {WORKFLOW_PLATFORMS.map((p) => {
              const on = platforms.includes(p);
              return (
                <button
                  key={p}
                  type="button"
                  aria-pressed={on}
                  onClick={() => togglePlatform(p)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                    on
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground',
                  )}
                >
                  {f.platform(p)}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-tags`}>{t('projectTags')}</Label>
          <Input id={`${id}-tags`} value={tags} onChange={(e) => setTags(e.target.value)} />
        </div>
      </fieldset>

      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problemMessage(problem)}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>
          {initial ? t('save') : t('create')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
          {tc('cancel')}
        </Button>
      </div>
    </form>
  );
}
