'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { useFormat } from '@/lib/client/format';
import { LANGUAGES, type StudioLanguage } from '@/lib/studio/languages';
import { cn } from '@/lib/utils';
import { DRIP_HORIZON_WEEKS } from '@/lib/studio/drip-presets';
import { scheduleInputBounds } from '../automation/schedule-bounds';
import { Field, NativeSelect } from '../review/field';
import { tiersAtOrBelow, type CreateState, type QualityTier } from './body';

// Phase 15 Track C — Create options: the video's language(s) (15.C5) and the advanced
// "quality tier", "schedule" and "approval workflow" choices (15.C4, spec 14.1).

type Patch = (patch: Partial<CreateState>) => void;

export interface WorkflowOption {
  id: string;
  name: string;
}

/** A content language's name in the interface language (English names in English). */
function useLanguageName(): (l: StudioLanguage) => string {
  const { locale } = useFormat();
  if (locale.startsWith('en')) return (l) => l.name;
  const names = new Intl.DisplayNames([locale], { type: 'language' });
  return (l) => names.of(l.code) ?? l.name;
}

export function LanguageOptions({ state, onChange }: { state: CreateState; onChange: Patch }) {
  const t = useTranslations('create.planning');
  const languageName = useLanguageName();
  const primary = state.language ?? 'en-GB';
  const extras = state.extraLanguages ?? [];
  const toggle = (code: string) =>
    onChange({
      extraLanguages: extras.includes(code) ? extras.filter((c) => c !== code) : [...extras, code],
    });
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field id="create-language" label={t('language')}>
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
              {languageName(l) === l.nativeName
                ? l.nativeName
                : t('languageOption', { name: languageName(l), nativeName: l.nativeName })}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <fieldset>
        <legend className="mb-2 text-xs font-medium text-muted-foreground">
          {t('alsoMakeIn')}
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
  const t = useTranslations('create.planning');
  const isSlideshow = state.source === 'SLIDESHOW';
  // 20.3: the API's window (a minute to 180 days ahead), fixed when the options open.
  const [bounds] = useState(() => scheduleInputBounds(Date.now()));
  return (
    <>
      <Field id="create-tier" label={t('tier')} hint={t('tierHint')}>
        <NativeSelect
          id="create-tier"
          value={state.qualityTier ?? ''}
          disabled={!planTier || isSlideshow}
          onChange={(e) => onChange({ qualityTier: e.target.value as QualityTier | '' })}
        >
          <option value="">
            {planTier ? t('tierPlan', { tier: t(`tiers.${planTier}`) }) : t('tierPlanUnknown')}
          </option>
          {planTier &&
            tiersAtOrBelow(planTier)
              .filter((t) => t !== planTier)
              .reverse()
              .map((tier) => (
                <option key={tier} value={tier}>
                  {t(`tiers.${tier}`)}
                </option>
              ))}
        </NativeSelect>
      </Field>
      <Field id="create-schedule" label={t('schedule')} hint={t('scheduleHint')}>
        <Input
          id="create-schedule"
          type="datetime-local"
          min={bounds.min}
          max={bounds.max}
          value={state.scheduleNextSlot ? '' : (state.scheduleAt ?? '')}
          disabled={isSlideshow || state.scheduleNextSlot}
          onChange={(e) => onChange({ scheduleAt: e.target.value })}
        />
        <label className="mt-2 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-foreground"
            checked={Boolean(state.scheduleNextSlot)}
            disabled={isSlideshow}
            onChange={(e) =>
              onChange({
                scheduleNextSlot: e.target.checked,
                ...(e.target.checked && { scheduleAt: '' }),
              })
            }
          />
          <span>
            {t('scheduleNextSlot')}
            <span className="block text-xs text-muted-foreground">
              {t('scheduleNextSlotHint', { weeks: DRIP_HORIZON_WEEKS })}
            </span>
          </span>
        </label>
      </Field>
      <Field id="create-workflow" label={t('workflow')}>
        <NativeSelect
          id="create-workflow"
          value={state.approvalWorkflowId ?? ''}
          disabled={!workflows || workflows.length === 0}
          onChange={(e) => onChange({ approvalWorkflowId: e.target.value })}
        >
          <option value="">
            {workflows && workflows.length === 0 ? t('workflowNone') : t('workflowOrg')}
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
