'use client';

import { Minus, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/client/format';
import { videosToQuarters } from '@/lib/studio/billing/allowance-units';
import { SegmentedControl } from '@/components/ui/segmented-control';
import type { ChannelInterval, PricingView } from './types';

// Phase 21.5 — the one plan control, shared by /pricing, sign-up and "Your plan": how many
// channels (1–6, a stepper) and how often to pay (weekly, monthly, yearly), with the total for
// the period, the per-channel price, the videos included and the yearly saving. Amounts come from
// Stripe (PricingView); a missing price reads "Price unavailable", never an invented number. No
// generation cost is ever shown.

export interface ChannelChoice {
  channels: number;
  interval: ChannelInterval;
}

const INTERVALS: readonly ChannelInterval[] = ['week', 'month', 'year'];

export function IntervalSwitch({
  value,
  onChange,
  disabled,
}: {
  value: ChannelInterval;
  onChange: (next: ChannelInterval) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('channelPlan.interval');
  return (
    <SegmentedControl
      label={t('label')}
      fullWidth
      className="sm:inline-flex sm:w-auto"
      disabled={disabled}
      value={value}
      onChange={onChange}
      options={INTERVALS.map((option) => ({ value: option, label: t(option) }))}
    />
  );
}

export function ChannelStepper({
  value,
  min,
  max,
  onChange,
  disabled,
  id,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  id: string;
}) {
  const t = useTranslations('channelPlan.channels');
  return (
    <div className="grid gap-2">
      <span id={`${id}-label`} className="text-sm font-medium">
        {t('label')}
      </span>
      <div role="group" aria-labelledby={`${id}-label`} className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t('fewer')}
          disabled={disabled || value <= min}
          onClick={() => onChange(Math.max(min, value - 1))}
        >
          <Minus aria-hidden />
        </Button>
        <output
          id={id}
          aria-live="polite"
          className="min-w-24 text-center font-display text-2xl tabular-nums"
        >
          {t('value', { count: value })}
        </output>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t('more')}
          disabled={disabled || value >= max}
          onClick={() => onChange(Math.min(max, value + 1))}
        >
          <Plus aria-hidden />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
    </div>
  );
}

/** The total, per-channel price, videos included and the yearly saving for a choice. */
export function ChoiceSummary({
  choice,
  pricing,
}: {
  choice: ChannelChoice;
  pricing: PricingView;
}) {
  const t = useTranslations('channelPlan');
  const f = useFormat();
  const view = pricing.intervals.find((i) => i.interval === choice.interval);
  const unit = view?.unitAmountPence ?? null;
  const included = (view?.videosPerChannel ?? 0) * choice.channels;
  const perWindow = choice.interval === 'week' ? (view?.videosPerChannel ?? 0) : 8;
  const saving =
    choice.interval === 'year' && pricing.yearlySavingPerChannelPence
      ? pricing.yearlySavingPerChannelPence * choice.channels
      : null;
  return (
    <div className="grid gap-2" aria-live="polite">
      {unit === null ? (
        <p className="font-display text-3xl leading-none text-muted-foreground">
          {t('priceUnavailable')}
        </p>
      ) : (
        <>
          <p className="font-display text-4xl leading-none tabular-nums">
            {t(`total.${choice.interval}`, { amount: f.pence(unit * choice.channels) })}
          </p>
          <p className="text-sm text-muted-foreground">
            {t(`perChannel.${choice.interval}`, { amount: f.pence(unit) })} · {t('exclVat')}
          </p>
        </>
      )}
      <ul className="grid gap-1 text-sm">
        <li>{t(`included.${choice.interval}`, { count: included, perChannel: perWindow })}</li>
        <li>{t('quickPosts', { count: videosToQuarters(included) })}</li>
        <li>{t('hd')}</li>
        {saving !== null && saving > 0 && (
          <li className="font-medium text-success">
            {t('yearlySaving', { amount: f.pence(saving) })}
          </li>
        )}
        {choice.interval === 'week' && <li className="text-muted-foreground">{t('weeklyNote')}</li>}
      </ul>
    </div>
  );
}

/** Stepper + period switch + summary: the whole choice in one block (mobile first). */
export function ChannelPicker({
  value,
  onChange,
  pricing,
  disabled,
  id = 'channel-picker',
}: {
  value: ChannelChoice;
  onChange: (next: ChannelChoice) => void;
  pricing: PricingView;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-start">
      <div className="grid gap-5">
        <IntervalSwitch
          value={value.interval}
          disabled={disabled}
          onChange={(interval) => onChange({ ...value, interval })}
        />
        <ChannelStepper
          id={`${id}-channels`}
          value={value.channels}
          min={pricing.channels.min}
          max={pricing.channels.max}
          disabled={disabled}
          onChange={(channels) => onChange({ ...value, channels })}
        />
      </div>
      <ChoiceSummary choice={value} pricing={pricing} />
    </div>
  );
}

/** "5 HD videos" for a video pack. */
export function usePackName(): (pack: { quantity: number }) => string {
  const t = useTranslations('channelPlan.packs');
  return (pack) => t('name', { quantity: pack.quantity });
}

/** Parse ?channels=&interval= (sign-up and links from /pricing); invalid values are ignored. */
export function choiceFromParams(
  params: { get(name: string): string | null } | null,
  fallback: ChannelChoice,
  max: number,
): ChannelChoice {
  const channels = Number(params?.get('channels'));
  const interval = params?.get('interval');
  return {
    channels:
      Number.isInteger(channels) && channels >= 1 && channels <= max ? channels : fallback.channels,
    interval:
      interval === 'week' || interval === 'month' || interval === 'year'
        ? interval
        : fallback.interval,
  };
}
