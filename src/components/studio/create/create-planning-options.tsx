'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { useFormat } from '@/lib/client/format';
import { LANGUAGES, type StudioLanguage } from '@/lib/studio/languages';
import { DRIP_HORIZON_WEEKS } from '@/lib/studio/drip-presets';
import { scheduleInputBounds } from '../automation/schedule-bounds';
import { NativeSelect } from '@/components/ui/native-select';
import { ChoiceChips } from '@/components/ui/choice-chips';
import { Field } from '../review/field';
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
  const alsoId = useId();
  return (
    <div className="grid gap-4 @lg:grid-cols-2">
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
        <legend id={alsoId} className="mb-2 text-xs font-medium text-muted-foreground">
          {t('alsoMakeIn')}
        </legend>
        <ChoiceChips
          type="multiple"
          size="sm"
          aria-labelledby={alsoId}
          value={extras}
          onChange={(extraLanguages) => onChange({ extraLanguages })}
          options={LANGUAGES.filter((l) => l.code !== primary).map((l) => ({
            value: l.code,
            disabled: !extras.includes(l.code) && extras.length >= 4,
            label: <span lang={l.code}>{l.nativeName}</span>,
          }))}
        />
      </fieldset>
    </div>
  );
}

/** 15.C4: a lower quality tier for this run (never above the plan). */
export function TierSelect({
  state,
  onChange,
  planTier,
}: {
  state: CreateState;
  onChange: Patch;
  planTier: QualityTier | undefined;
}) {
  const t = useTranslations('create.planning');
  return (
    <Field id="create-tier" label={t('tier')} hint={t('tierHint')}>
      <NativeSelect
        id="create-tier"
        value={state.qualityTier ?? ''}
        disabled={!planTier || state.source === 'SLIDESHOW'}
        onChange={(e) => onChange({ qualityTier: e.target.value as QualityTier | '' })}
      >
        <option value="">
          {planTier ? t('tierPlan', { tier: t(`tiers.${planTier}`) }) : t('tierPlanUnknown')}
        </option>
        {planTier &&
          tiersAtOrBelow(planTier)
            .filter((tier) => tier !== planTier)
            .reverse()
            .map((tier) => (
              <option key={tier} value={tier}>
                {t(`tiers.${tier}`)}
              </option>
            ))}
      </NativeSelect>
    </Field>
  );
}

/** 15.C4 / 20.3: publish at a date-time, or at the drip queue's next free slot. */
export function ScheduleField({
  state,
  onChange,
  canSchedule = true,
}: {
  state: CreateState;
  onChange: Patch;
  /** 20.12: a schedule posts automatically, so it needs a connected account. */
  canSchedule?: boolean;
}) {
  const t = useTranslations('create.planning');
  // 20.3: the API's window (a minute to 180 days ahead), fixed when the options open.
  const [bounds] = useState(() => scheduleInputBounds(Date.now()));
  return (
    <Field
      id="create-schedule"
      label={t('schedule')}
      hint={
        canSchedule ? (
          t('scheduleHint')
        ) : (
          <>
            {t('scheduleNeedsAccount')}{' '}
            <Link href="/connections" className="underline">
              {t('connectAccount')}
            </Link>
          </>
        )
      }
    >
      <Input
        id="create-schedule"
        type="datetime-local"
        min={bounds.min}
        max={bounds.max}
        value={state.scheduleNextSlot ? '' : (state.scheduleAt ?? '')}
        disabled={!canSchedule || state.scheduleNextSlot}
        onChange={(e) => onChange({ scheduleAt: e.target.value })}
      />
      <label className="mt-2 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-foreground"
          checked={Boolean(state.scheduleNextSlot)}
          disabled={!canSchedule}
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
  );
}

/** 15.C4 / 15.D3: an approval workflow ('' = the organisation's matching rule). */
export function WorkflowSelect({
  state,
  onChange,
  workflows,
}: {
  state: CreateState;
  onChange: Patch;
  workflows: WorkflowOption[] | undefined;
}) {
  const t = useTranslations('create.planning');
  return (
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
  );
}

/** P5 (operator decision 2026-09-28): the Basic plan starts on Slideshow; others on Video. */
export function defaultSourceFor(planTier: QualityTier | undefined): 'BRIEF' | 'SLIDESHOW' {
  return planTier === 'BASIC' ? 'SLIDESHOW' : 'BRIEF';
}
