'use client';

import { useId } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { useFormat, type StudioFormat } from '@/lib/client/format';
import type { BrandKit } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import { NativeSelect } from '@/components/ui/native-select';
import { ChoiceChips } from '@/components/ui/choice-chips';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Field } from '../review/field';
import type { CreateState, QualityTier, ReviewPolicy } from './body';
import { PlanningAdvancedOptions, type WorkflowOption } from './create-planning-options';
import {
  defaultProjectBudgetPence,
  longFormBudgetPence,
  shortFormBudgetPence,
} from '@/lib/studio/cost/project-budget';
import { buildFormats, PLATFORM_OPTIONS, type Length } from './formats';

// The three low-friction defaults (platforms, length, brand kit) plus the collapsed advanced
// options of spec 14.1. Everything here has a sensible default, so Generate works untouched.

type Patch = (patch: Partial<CreateState>) => void;

type AdvancedT = ReturnType<typeof useTranslations<'create.options.advanced'>>;

/** The budget the server applies when the field is left blank (cost/project-budget.ts). A
 *  template's formats are only known server-side, so its placeholder names both defaults. */
function budgetPlaceholder(
  state: CreateState,
  t: AdvancedT,
  f: StudioFormat,
  planTier: QualityTier | undefined,
): string {
  if (state.projectTemplate) {
    return t('budgetPlaceholderTemplate', {
      short: f.pence(shortFormBudgetPence(planTier)),
      long: f.pence(longFormBudgetPence(planTier)),
    });
  }
  const formats = buildFormats(state.platforms, state.length);
  return t('budgetPlaceholder', {
    amount: f.pence(defaultProjectBudgetPence(formats, state.source, planTier)),
  });
}

export function PlatformChips({ value, onChange }: { value: string[]; onChange: Patch }) {
  const t = useTranslations('create.options');
  const f = useFormat();
  const legendId = useId();
  return (
    <fieldset>
      <legend id={legendId} className="mb-2 text-xs font-medium text-muted-foreground">
        {t('platforms')}
      </legend>
      <ChoiceChips
        type="multiple"
        aria-labelledby={legendId}
        value={value}
        onChange={(platforms) => onChange({ platforms })}
        options={PLATFORM_OPTIONS.map((o) => ({
          value: o.platform,
          label: f.platform(o.platform),
        }))}
      />
    </fieldset>
  );
}

export function LengthToggle({ value, onChange }: { value: Length; onChange: Patch }) {
  const t = useTranslations('create.options');
  const legendId = useId();
  return (
    <fieldset>
      <legend id={legendId} className="mb-2 text-xs font-medium text-muted-foreground">
        {t('length')}
      </legend>
      <SegmentedControl
        aria-labelledby={legendId}
        value={value}
        onChange={(length) => onChange({ length })}
        options={(['short', 'long'] as const).map((l) => ({ value: l, label: t(`lengths.${l}`) }))}
      />
    </fieldset>
  );
}

export function BrandKitSelect({
  kits,
  value,
  onChange,
}: {
  kits: BrandKit[] | undefined;
  value: string | null;
  onChange: Patch;
}) {
  const t = useTranslations('create.options.brandKit');
  return (
    <Field id="create-brand-kit" label={t('label')}>
      <NativeSelect
        id="create-brand-kit"
        value={value ?? ''}
        disabled={!kits}
        onChange={(e) => onChange({ brandKitId: e.target.value || null })}
      >
        <option value="">{kits ? t('none') : t('loading')}</option>
        {kits?.map((k) => (
          <option key={k.id} value={k.id}>
            {k.isDefault ? t('defaultKit', { name: k.name }) : k.name}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

export function AdvancedOptions({
  state,
  onChange,
  open,
  onToggle,
  planTier,
  workflows,
  canSchedule = true,
  showCosts = false,
}: {
  state: CreateState;
  onChange: Patch;
  open: boolean;
  onToggle: () => void;
  /** 15.C4: the organisation's plan (tier override ceiling) and approval workflows. */
  planTier?: QualityTier;
  workflows?: WorkflowOption[];
  /** 20.12: false when no connected account can post (a schedule posts automatically). */
  canSchedule?: boolean;
  /** Operator decision 2026-10-04: only platform staff see (and set) the per-project budget;
   *  customers leave it blank and the server applies the default (cost/project-budget.ts). */
  showCosts?: boolean;
}) {
  const t = useTranslations('create.options.advanced');
  const f = useFormat();
  return (
    <div className="border-t border-border/70 pt-4">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="create-advanced"
        onClick={onToggle}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
        {t('toggle')}
      </button>
      {open && (
        <div id="create-advanced" className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field id="create-audience" label={t('audience')}>
            <Input
              id="create-audience"
              maxLength={500}
              value={state.targetAudience}
              disabled={state.source === 'SLIDESHOW'}
              onChange={(e) => onChange({ targetAudience: e.target.value })}
              placeholder={t('audiencePlaceholder')}
            />
          </Field>
          <Field id="create-cta" label={t('cta')}>
            <Input
              id="create-cta"
              maxLength={200}
              value={state.callToAction}
              disabled={state.source === 'SLIDESHOW'}
              onChange={(e) => onChange({ callToAction: e.target.value })}
              placeholder={t('ctaPlaceholder')}
            />
          </Field>
          {showCosts && (
            <Field
              id="create-budget"
              label={t('budget')}
              hint={t('budgetHint', {
                short: f.pence(shortFormBudgetPence(planTier)),
                long: f.pence(longFormBudgetPence(planTier)),
              })}
            >
              <Input
                id="create-budget"
                inputMode="decimal"
                value={state.budgetPounds}
                onChange={(e) => onChange({ budgetPounds: e.target.value })}
                placeholder={budgetPlaceholder(state, t, f, planTier)}
              />
            </Field>
          )}
          <Field id="create-review" label={t('approval')}>
            <NativeSelect
              id="create-review"
              value={state.reviewPolicy}
              onChange={(e) => onChange({ reviewPolicy: e.target.value as ReviewPolicy | '' })}
            >
              <option value="">{t('approvalDefault')}</option>
              <option value="REQUIRE_APPROVAL">{t('approvalRequire')}</option>
              <option value="AUTO_APPROVE">{t('approvalAuto')}</option>
            </NativeSelect>
          </Field>
          <PlanningAdvancedOptions
            state={state}
            onChange={onChange}
            planTier={planTier}
            workflows={workflows}
            canSchedule={canSchedule}
          />
        </div>
      )}
    </div>
  );
}
