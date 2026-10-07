'use client';

import { Gauge } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { Banner } from './account/account-banners';
import { UsageBannerActions } from './billing/upgrade-dialog';

// Decision P3 — the plan usage meter (GET /api/studio/usage). The app shell shows the banner from
// 80 % of any monthly video quota (the spec 12.5 alert thresholds); the admin panel reuses the
// meters. Usage is informational: a failed read renders nothing rather than an error.

export interface QuotaMeterView {
  used: number;
  limit: number | null;
  percent: number | null;
  maxDurationSec: number | null;
  /** 23.3: exact usage in quarters of a video (a quick post uses 1, a video 4). */
  usedQuarters?: number;
  limitQuarters?: number | null;
}

export interface UsageResponse {
  usage: {
    organisationId: string;
    planTier: 'BASIC' | 'STANDARD' | 'PLUS' | 'ENTERPRISE';
    mode: 'warn' | 'enforce';
    month: string;
    /** 21.5: the allowance window (a weekly channel plan counts per ISO week). */
    period?: 'week' | 'month';
    /** 21.5: a per-channel plan (no tier names, no long videos). */
    channelPlan?: boolean;
    periodStart: string;
    resetsAt: string;
    thresholds: number[];
    status: 'ok' | 'warning' | 'exceeded';
    videos: { short: QuotaMeterView; long: QuotaMeterView };
    platforms: { rule: string; description: string };
    scans: { businessesScanned: number; limit: number | null };
    imageGeneration?: { businessId: string; used: number; cap: number; remaining: number };
  };
}

/** The reset day (UTC: quotas are calendar months in UTC) in the reader's locale. */
function useResetDate(): (iso: string) => string {
  const f = useFormat();
  return (iso) => f.date(iso, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** Meters warn at 80 % of a limit and reach the error tone only at 100 %. */
export const METER_WARN_AT = 80;
export const METER_FULL_AT = 100;

/**
 * 25.12: a meter's fill. Neutral data teal by default (not the vermilion signal: red means a limit),
 * warning from 80 %, destructive at 100 %. Every fill keeps 3:1 against the track
 * (test/unit/design-tokens-contrast.test.ts).
 */
export function meterFillClass(percent: number): 'bg-data' | 'bg-warning' | 'bg-destructive' {
  if (percent >= METER_FULL_AT) return 'bg-destructive';
  if (percent >= METER_WARN_AT) return 'bg-warning';
  return 'bg-data';
}

export function MeterRow({ label, meter }: { label: string; meter: QuotaMeterView }) {
  const t = useTranslations('shell.usage');
  const limitText =
    meter.limit === null
      ? t('usedUnlimited', { used: meter.used })
      : t('usedOf', { used: meter.used, limit: meter.limit });
  const pct = meter.limit === null ? 0 : Math.min(100, meter.percent ?? 0);
  const tone = meterFillClass(pct);
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">{limitText}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={meter.limit ?? meter.used}
        aria-valuenow={meter.used}
        className="h-1.5 overflow-hidden rounded-full bg-secondary"
      >
        <div
          className={cn('h-full rounded-full transition-[width]', tone)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function UsageMeters({ usage }: { usage: UsageResponse['usage'] }) {
  const t = useTranslations('shell.usage');
  const resetDate = useResetDate();
  const short = usage.videos.short.maxDurationSec;
  const long = usage.videos.long.maxDurationSec;
  const tier = t(`tiers.${usage.planTier}`);
  // 21.5: a per-channel plan shows videos per week or month, never a tier name or long videos.
  if (usage.channelPlan)
    return (
      <div className="grid gap-4">
        <MeterRow
          label={t('videosThisPeriod', { period: usage.period ?? 'month' })}
          meter={usage.videos.short}
        />
        <p className="text-xs text-muted-foreground">
          {t('moreFrom', { date: resetDate(usage.resetsAt) })} {t('quickPostsNote')}
        </p>
      </div>
    );
  const summary = [
    t('planName', { tier }),
    usage.platforms.description,
    usage.scans.limit === null
      ? t('scansUnlimited', { scanned: usage.scans.businessesScanned })
      : t('scans', { scanned: usage.scans.businessesScanned, limit: usage.scans.limit }),
    t('resets', { date: resetDate(usage.resetsAt) }),
    usage.mode === 'enforce' ? t('enforced') : t('notEnforced'),
  ];
  return (
    <div className="grid gap-4">
      <MeterRow
        label={short ? t('shortVideosUpTo', { seconds: short }) : t('shortVideos')}
        meter={usage.videos.short}
      />
      <MeterRow
        label={long ? t('longVideosUpTo', { minutes: Math.round(long / 60) }) : t('longVideos')}
        meter={usage.videos.long}
      />
      <p className="text-xs text-muted-foreground">{summary.join(' · ')}</p>
    </div>
  );
}

/** App-shell banner: rendered only once a monthly quota reaches 80 %. */
export function UsageBanner() {
  const t = useTranslations('shell.usage');
  const resetDate = useResetDate();
  const res = useApi<UsageResponse>('/usage');
  const usage = res.data?.usage;
  if (!usage || usage.status === 'ok') return null;
  const exceeded = usage.status === 'exceeded';
  const blocked = exceeded && usage.mode === 'enforce';
  return (
    <section
      role="status"
      aria-label={t('bannerAria')}
      className={cn(
        'mb-6 grid gap-4 rounded-xl border p-4 md:grid-cols-[auto_1fr_minmax(14rem,20rem)] md:items-center',
        exceeded ? 'border-destructive/40 bg-destructive/5' : 'border-warning/50 bg-warning/10',
      )}
    >
      <Gauge className="size-6 text-muted-foreground" strokeWidth={1.5} aria-hidden />
      <div className="text-sm">
        {usage.channelPlan ? (
          <>
            <p className="font-medium">
              {exceeded
                ? t('planExceededTitle', { period: usage.period ?? 'month' })
                : t('planWarningTitle', { period: usage.period ?? 'month' })}
            </p>
            <p className="text-muted-foreground">
              {blocked
                ? t('planBlockedBody', { date: resetDate(usage.resetsAt) })
                : t('planResetBody', { date: resetDate(usage.resetsAt) })}
            </p>
          </>
        ) : (
          <>
            <p className="font-medium">
              {exceeded
                ? t('exceededTitle', { tier: t(`tiers.${usage.planTier}`) })
                : t('warningTitle', { tier: t(`tiers.${usage.planTier}`) })}
            </p>
            <p className="text-muted-foreground">
              {blocked
                ? t('blockedBody', { date: resetDate(usage.resetsAt) })
                : t('resetBody', { date: resetDate(usage.resetsAt) })}
            </p>
          </>
        )}
        {usage.channelPlan && <p className="text-muted-foreground">{t('quickPostsNote')}</p>}
        <UsageBannerActions />
      </div>
      <div className="grid gap-3">
        <MeterRow
          label={usage.channelPlan ? t('videos') : t('shortVideos')}
          meter={usage.videos.short}
        />
        {usage.videos.long.limit !== 0 && !usage.channelPlan && (
          <MeterRow label={t('longVideos')} meter={usage.videos.long} />
        )}
      </div>
    </section>
  );
}

/** The usage read the app shell shares between the notice strip and its priority order. */
export function useUsage(): UsageResponse['usage'] | undefined {
  return useApi<UsageResponse>('/usage').data?.usage;
}

/**
 * 25.4: the usage warning as one row of the app shell's notice strip (the full banner with meters
 * stays above for screens that show it on its own). Rendered only while usage is not `ok`.
 */
export function UsageNotice({ usage }: { usage: UsageResponse['usage'] }) {
  const t = useTranslations('shell.usage');
  const resetDate = useResetDate();
  const exceeded = usage.status === 'exceeded';
  const blocked = exceeded && usage.mode === 'enforce';
  const period = usage.period ?? 'month';
  const title = usage.channelPlan
    ? exceeded
      ? t('planExceededTitle', { period })
      : t('planWarningTitle', { period })
    : exceeded
      ? t('exceededTitle', { tier: t(`tiers.${usage.planTier}`) })
      : t('warningTitle', { tier: t(`tiers.${usage.planTier}`) });
  const date = resetDate(usage.resetsAt);
  const body = usage.channelPlan
    ? blocked
      ? t('planBlockedBody', { date })
      : t('planResetBody', { date })
    : blocked
      ? t('blockedBody', { date })
      : t('resetBody', { date });
  return (
    <Banner
      tone={exceeded ? 'bad' : 'warn'}
      icon={<Gauge className="size-4" />}
      action={<UsageBannerActions compact />}
    >
      <strong className="font-semibold">{title}</strong> {body}
    </Banner>
  );
}
