'use client';

import { useRef, type KeyboardEvent } from 'react';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { StatusPill } from '@/components/ui/status-pill';
import { nextEnabled, rovingDelta } from '@/components/ui/roving';
import { useFormat } from '@/lib/client/format';
import { videosToQuarters } from '@/lib/studio/billing/allowance-units';
import { isPlanId, isPlanInterval, PLAN_IDS, PLAN_NAMES } from '@/lib/studio/billing/plans';
import { cn } from '@/lib/utils';
import type { PlanChoice, PlanInterval, PlanPricingView, PricingView } from './types';

// Phase 26.1 — the one plan control, shared by /pricing, "Choose your plan" and "Change your
// plan": how often you pay (weekly, monthly, yearly) and one of three plans, Starter, Growth and
// Pro (cheapest first, Pro last; Growth marked "Most popular"). Each plan shows its price for the
// period (excl. VAT, from Stripe: a missing price reads "Price unavailable", never an invented
// number), the HD videos it includes a month (a week on weekly), the quick-post equivalent,
// businesses, seats, and that it posts to every platform. Plan names are product names, never
// translated. The cards are a radio group (roving focus, arrow keys select), like ChoiceChips.

const INTERVALS: readonly PlanInterval[] = ['week', 'month', 'year'];

export function IntervalSwitch({
  value,
  onChange,
  disabled,
}: {
  value: PlanInterval;
  onChange: (next: PlanInterval) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('planPicker.interval');
  return (
    <div className="grid gap-1.5 sm:flex sm:items-center sm:gap-3">
      <SegmentedControl
        label={t('label')}
        fullWidth
        className="sm:inline-flex sm:w-auto"
        disabled={disabled}
        value={value}
        onChange={onChange}
        options={INTERVALS.map((option) => ({ value: option, label: t(option) }))}
      />
      <p className="text-xs text-foreground-secondary">{t('yearlyHint')}</p>
    </div>
  );
}

/** The plans in display order (Starter, Growth, Pro), whatever order the API sent. */
export function orderedPlans(pricing: PricingView): PlanPricingView[] {
  return PLAN_IDS.flatMap((id) => pricing.plans.filter((p) => p.plan === id));
}

function PlanCard({
  view,
  interval,
  checked,
  tabStop,
  disabled,
  id,
  cardRef,
  onSelect,
}: {
  view: PlanPricingView;
  interval: PlanInterval;
  checked: boolean;
  tabStop: boolean;
  disabled: boolean;
  id: string;
  cardRef: (el: HTMLDivElement | null) => void;
  onSelect: () => void;
}) {
  const t = useTranslations('planPicker');
  const f = useFormat();
  const amount = view.prices[interval].unitAmountPence;
  const videos = interval === 'week' ? view.videosPerWeek : view.videosPerMonth;
  const saving = interval === 'year' ? view.yearlySavingPence : null;
  const nameId = `${id}-${view.plan}-name`;
  const detailsId = `${id}-${view.plan}-details`;
  return (
    <div
      ref={cardRef}
      role="radio"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      aria-labelledby={nameId}
      aria-describedby={detailsId}
      tabIndex={tabStop && !disabled ? 0 : -1}
      data-testid={`plan-option-${view.plan}`}
      data-state={checked ? 'checked' : 'unchecked'}
      onClick={() => !disabled && onSelect()}
      onKeyDown={(e) => {
        if (disabled || (e.key !== ' ' && e.key !== 'Enter')) return;
        e.preventDefault();
        onSelect();
      }}
      className={cn(
        'relative grid cursor-pointer content-start gap-4 rounded-panel bg-background p-5 ring-1 select-none',
        'transition-[box-shadow,background-color] duration-(--duration-fast) ease-standard',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        checked
          ? 'bg-surface-active shadow-raised ring-2 ring-foreground/70'
          : 'ring-border hover:bg-surface-raised hover:ring-border-strong',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <div className="flex min-h-6 flex-wrap items-center justify-between gap-2">
        <p id={nameId} className="font-display text-2xl leading-none">
          {PLAN_NAMES[view.plan]}
        </p>
        {view.mostPopular && (
          <StatusPill tone="live" dot={false}>
            {t('mostPopular')}
          </StatusPill>
        )}
      </div>
      <div className="grid gap-1" aria-live="polite">
        {amount === null ? (
          <p className="font-display text-xl text-foreground-secondary">{t('priceUnavailable')}</p>
        ) : (
          <p className="font-display text-3xl leading-none tabular-nums">
            {t(`total.${interval}`, { amount: f.pence(amount) })}
          </p>
        )}
        <p className="text-xs text-foreground-secondary">{t('exclVat')}</p>
        {saving !== null && saving > 0 && (
          <p className="text-sm font-medium text-success-foreground">
            {t('yearlySaving', { amount: f.pence(saving) })}
          </p>
        )}
      </div>
      <ul id={detailsId} className="grid gap-1.5 text-sm">
        {[
          t(`videos.${interval === 'week' ? 'week' : 'month'}`, { count: videos }),
          t('quickPosts', { count: videosToQuarters(videos) }),
          t('businesses', { count: view.businesses }),
          t('seats', { count: view.seats }),
          t('platforms'),
        ].map((line) => (
          <li key={line} className="flex items-start gap-2">
            <Check className="mt-0.5 size-3.5 shrink-0 text-foreground-secondary" aria-hidden />
            {line}
          </li>
        ))}
      </ul>
      {checked && (
        <span
          aria-hidden
          className="absolute -top-2 -end-2 grid size-6 place-items-center rounded-full bg-foreground text-background"
        >
          <Check className="size-3.5" strokeWidth={3} />
        </span>
      )}
    </div>
  );
}

/** Interval switch + the three plan cards: the whole choice in one block (mobile first). */
export function PlanPicker({
  value,
  onChange,
  pricing,
  disabled = false,
  id = 'plan-picker',
}: {
  value: PlanChoice;
  onChange: (next: PlanChoice) => void;
  pricing: PricingView;
  disabled?: boolean;
  id?: string;
}) {
  const t = useTranslations('planPicker');
  const plans = orderedPlans(pricing);
  const refs = useRef<Array<HTMLDivElement | null>>([]);
  const checkedIndex = plans.findIndex((p) => p.plan === value.plan);
  const tabStop = checkedIndex === -1 ? 0 : checkedIndex;
  const off = plans.map(() => disabled);

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = refs.current.findIndex((el) => el === event.target);
    if (from === -1) return;
    const delta = rovingDelta(event, plans.length, from);
    if (delta === null) return;
    event.preventDefault();
    const next = nextEnabled(from, delta, off);
    const option = next === null ? undefined : plans[next];
    if (next === null || !option) return;
    refs.current[next]?.focus();
    onChange({ ...value, plan: option.plan });
  };

  return (
    <div className="grid gap-5" data-testid="plan-picker">
      <IntervalSwitch
        value={value.interval}
        disabled={disabled}
        onChange={(interval) => onChange({ ...value, interval })}
      />
      <div
        role="radiogroup"
        aria-label={t('label')}
        aria-disabled={disabled || undefined}
        onKeyDown={onKey}
        className="grid gap-4 pt-2 md:grid-cols-3"
      >
        {plans.map((view, i) => (
          <PlanCard
            key={view.plan}
            id={id}
            view={view}
            interval={value.interval}
            checked={view.plan === value.plan}
            tabStop={i === tabStop}
            disabled={disabled}
            cardRef={(el) => {
              refs.current[i] = el;
            }}
            onSelect={() => onChange({ ...value, plan: view.plan })}
          />
        ))}
      </div>
      {value.interval === 'week' && (
        <p className="text-sm text-foreground-secondary">{t('weeklyNote')}</p>
      )}
    </div>
  );
}

/** "5 HD videos" for a video pack. */
export function usePackName(): (pack: { quantity: number }) => string {
  const t = useTranslations('planPicker.packs');
  return (pack) => t('name', { quantity: pack.quantity });
}

/** Parse ?plan=&interval= (sign-up and links from /pricing); invalid values are ignored. */
export function choiceFromParams(
  params: { get(name: string): string | null } | null,
  fallback: PlanChoice,
): PlanChoice {
  const plan = params?.get('plan');
  const interval = params?.get('interval');
  return {
    plan: isPlanId(plan) ? plan : fallback.plan,
    interval: isPlanInterval(interval) ? interval : fallback.interval,
  };
}
