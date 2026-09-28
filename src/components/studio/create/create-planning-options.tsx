'use client';

import { Input } from '@/components/ui/input';
import { LANGUAGES } from '@/lib/studio/languages';
import { cn } from '@/lib/utils';
import { Field, NativeSelect } from '../review/field';
import { tiersAtOrBelow, type CreateState, type QualityTier } from './body';

// Phase 15 Track C — Create options: the video's language(s) (15.C5) and the advanced
// "quality tier", "schedule" and "approval workflow" choices (15.C4, spec 14.1).

type Patch = (patch: Partial<CreateState>) => void;

const TIER_LABEL: Record<QualityTier, string> = {
  BASIC: 'Basic',
  STANDARD: 'Standard',
  PLUS: 'Plus',
  ENTERPRISE: 'Enterprise',
};

export interface WorkflowOption {
  id: string;
  name: string;
}

export function LanguageOptions({ state, onChange }: { state: CreateState; onChange: Patch }) {
  const primary = state.language ?? 'en-GB';
  const extras = state.extraLanguages ?? [];
  const toggle = (code: string) =>
    onChange({
      extraLanguages: extras.includes(code) ? extras.filter((c) => c !== code) : [...extras, code],
    });
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field id="create-language" label="Language">
        <NativeSelect
          id="create-language"
          value={primary}
          onChange={(e) =>
            onChange({
              language: e.target.value,
              extraLanguages: extras.filter((c) => c !== e.target.value),
            })
          }
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name === l.nativeName ? l.name : `${l.name} — ${l.nativeName}`}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <fieldset>
        <legend className="mb-2 text-xs font-medium text-muted-foreground">
          Also make it in (one version per language)
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {LANGUAGES.filter((l) => l.code !== primary).map((l) => {
            const checked = extras.includes(l.code);
            return (
              <label
                key={l.code}
                lang={l.code}
                className={cn(
                  'inline-flex cursor-pointer items-center rounded-full border px-2.5 py-1 text-xs transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring',
                  checked
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={checked}
                  disabled={!checked && extras.length >= 4}
                  onChange={() => toggle(l.code)}
                />
                {l.nativeName}
              </label>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}

export function PlanningAdvancedOptions({
  state,
  onChange,
  planTier,
  workflows,
}: {
  state: CreateState;
  onChange: Patch;
  planTier: QualityTier | undefined;
  workflows: WorkflowOption[] | undefined;
}) {
  const isSlideshow = state.source === 'SLIDESHOW';
  return (
    <>
      <Field
        id="create-tier"
        label="Quality tier"
        hint="A lower tier uses cheaper providers for this video. It can never go above your plan."
      >
        <NativeSelect
          id="create-tier"
          value={state.qualityTier ?? ''}
          disabled={!planTier || isSlideshow}
          onChange={(e) => onChange({ qualityTier: e.target.value as QualityTier | '' })}
        >
          <option value="">{planTier ? `Your plan (${TIER_LABEL[planTier]})` : 'Your plan'}</option>
          {planTier &&
            tiersAtOrBelow(planTier)
              .filter((t) => t !== planTier)
              .reverse()
              .map((t) => (
                <option key={t} value={t}>
                  {TIER_LABEL[t]}
                </option>
              ))}
        </NativeSelect>
      </Field>
      <Field
        id="create-schedule"
        label="Schedule"
        hint="Publishes to the auto-publish accounts at this time once approved."
      >
        <Input
          id="create-schedule"
          type="datetime-local"
          value={state.scheduleAt ?? ''}
          disabled={isSlideshow}
          onChange={(e) => onChange({ scheduleAt: e.target.value })}
        />
      </Field>
      <Field id="create-workflow" label="Approval workflow">
        <NativeSelect
          id="create-workflow"
          value={state.approvalWorkflowId ?? ''}
          disabled={!workflows || workflows.length === 0}
          onChange={(e) => onChange({ approvalWorkflowId: e.target.value })}
        >
          <option value="">
            {workflows && workflows.length === 0 ? 'No workflows set up' : 'Organisation rules'}
          </option>
          {workflows?.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
    </>
  );
}

/** P5 (operator decision 2026-09-28): the Basic plan starts on Slideshow; others on Video. */
export function defaultSourceFor(planTier: QualityTier | undefined): 'BRIEF' | 'SLIDESHOW' {
  return planTier === 'BASIC' ? 'SLIDESHOW' : 'BRIEF';
}
