'use client';

import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import type { CustomLimits } from '@/lib/studio/billing/entitlements';
import type { ChannelInterval } from '../../billing/types';
import { CHANNEL_INTERVALS, isChannelInterval, type Access } from './entitlements-summary';

// Phase 18 §P.3 / 21.5 — the field groups of the staff entitlement override form (split out of
// entitlements-panel.tsx in 25.13): custom limits, the channel plan, and what the confirmation
// says before a change that locks people out or ends a trial.

const LIMIT_KEYS = [
  'seats',
  'businesses',
  'storageGb',
  'shortVideos',
  'longVideos',
  'longMaxSec',
  'generatedImagesPerBusinessPerMonth',
  'scanBusinesses',
] as const satisfies readonly (keyof CustomLimits)[];
export type LimitKey = (typeof LIMIT_KEYS)[number];
/** generatedImagesPerBusinessPerMonth cannot be unlimited (the schema has no null for it). */
const NO_UNLIMITED: ReadonlySet<LimitKey> = new Set(['generatedImagesPerBusinessPerMonth']);
export const MIN_REASON = 3;
/** 21.5: the channel plan's range (MIN_CHANNELS / MAX_CHANNELS in billing/channel-plan.ts). */
const CHANNEL_COUNTS = [1, 2, 3, 4, 5, 6] as const;

export interface LimitDraft {
  value: string;
  unlimited: boolean;
}

export const emptyLimits = (): Record<LimitKey, LimitDraft> =>
  Object.fromEntries(LIMIT_KEYS.map((k) => [k, { value: '', unlimited: false }])) as Record<
    LimitKey,
    LimitDraft
  >;

/** The limits object for the PUT body, or undefined when nothing is set. */
export function limitsFromDraft(draft: Record<LimitKey, LimitDraft>): CustomLimits | undefined {
  const entries = LIMIT_KEYS.flatMap((key): [LimitKey, number | null][] => {
    const d = draft[key];
    if (d.unlimited && !NO_UNLIMITED.has(key)) return [[key, null]];
    if (d.value.trim() === '') return [];
    return [[key, Math.max(0, Math.round(Number(d.value)))]];
  });
  return entries.length ? (Object.fromEntries(entries) as CustomLimits) : undefined;
}

export const toPence = (pounds: string): number | null =>
  pounds.trim() === '' || Number.isNaN(Number(pounds)) ? null : Math.round(Number(pounds) * 100);

export function LimitsFieldset({
  limits,
  onChange,
}: {
  limits: Record<LimitKey, LimitDraft>;
  onChange: (key: LimitKey, patch: Partial<LimitDraft>) => void;
}) {
  const t = useTranslations('billing.admin.entitlements.form');
  return (
    <fieldset className="grid gap-3">
      <legend className="font-medium">{t('limits')}</legend>
      <p className="text-xs text-muted-foreground">{t('limitsHelp')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {LIMIT_KEYS.map((key) => {
          const label = t(`limitLabels.${key}`);
          const d = limits[key];
          return (
            <div key={key} className="grid gap-1.5">
              <Label htmlFor={`ent-limit-${key}`}>{label}</Label>
              <div className="flex items-center gap-3">
                <Input
                  id={`ent-limit-${key}`}
                  type="number"
                  min={0}
                  step={1}
                  className="max-w-32"
                  value={d.value}
                  disabled={d.unlimited}
                  onChange={(e) => onChange(key, { value: e.target.value })}
                />
                {!NO_UNLIMITED.has(key) && (
                  <label className="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={d.unlimited}
                      aria-label={t('unlimitedAria', { limit: label })}
                      onChange={(e) => onChange(key, { unlimited: e.target.checked })}
                    />
                    {t('unlimited')}
                  </label>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

/** 21.5: the channel count (1–6) and billing interval staff give the organisation. */
export function ChannelPlanFields({
  channels,
  interval,
  onChannels,
  onInterval,
}: {
  channels: string;
  interval: ChannelInterval | '';
  onChannels: (value: string) => void;
  onInterval: (value: ChannelInterval | '') => void;
}) {
  const t = useTranslations('billing.admin.entitlements.form');
  const ta = useTranslations('billing.admin.entitlements');
  return (
    <fieldset className="grid gap-3">
      <legend className="font-medium">{t('channelPlan')}</legend>
      <p id="ent-channel-plan-help" className="text-xs text-muted-foreground">
        {t('channelPlanHelp')}
      </p>
      <div className="flex flex-wrap gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="ent-channels">{t('channels')}</Label>
          <NativeSelect
            id="ent-channels"
            value={channels}
            aria-describedby="ent-channel-plan-help"
            onChange={(e) => onChannels(e.target.value)}
          >
            <option value="">{t('keep')}</option>
            {CHANNEL_COUNTS.map((n) => (
              <option key={n} value={String(n)}>
                {t('channelsOption', { count: n })}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ent-interval">{t('interval')}</Label>
          <NativeSelect
            id="ent-interval"
            value={interval}
            aria-describedby="ent-channel-plan-help"
            onChange={(e) => onInterval(isChannelInterval(e.target.value) ? e.target.value : '')}
          >
            <option value="">{t('keep')}</option>
            {CHANNEL_INTERVALS.map((i) => (
              <option key={i} value={i}>
                {ta(`intervalValues.${i}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
    </fieldset>
  );
}

/** What the confirmation says, or null when the change needs none. */
export function useConfirmText(): (access: Access | '', endTrial: boolean) => string | null {
  const t = useTranslations('billing.admin.entitlements.confirm');
  return (access, endTrial) => {
    const lines = [
      access === 'none' ? t('accessNone') : null,
      access === 'read_only' ? t('accessReadOnly') : null,
      endTrial ? t('endTrial') : null,
    ].filter((l): l is string => l !== null);
    return lines.length ? lines.join(' ') : null;
  };
}
