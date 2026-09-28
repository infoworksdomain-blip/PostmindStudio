'use client';

import { Gauge } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';

// Decision P3 — the plan usage meter (GET /api/studio/usage). The app shell shows the banner from
// 80 % of any monthly video quota (the spec 12.5 alert thresholds); the admin panel reuses the
// meters. Usage is informational: a failed read renders nothing rather than an error.

export interface QuotaMeterView {
  used: number;
  limit: number | null;
  percent: number | null;
  maxDurationSec: number | null;
}

export interface UsageResponse {
  usage: {
    organisationId: string;
    planTier: 'BASIC' | 'STANDARD' | 'PLUS' | 'ENTERPRISE';
    mode: 'warn' | 'enforce';
    month: string;
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

export function MeterRow({ label, meter }: { label: string; meter: QuotaMeterView }) {
  const t = useTranslations('shell.usage');
  const limitText =
    meter.limit === null
      ? t('usedUnlimited', { used: meter.used })
      : t('usedOf', { used: meter.used, limit: meter.limit });
  const pct = meter.limit === null ? 0 : Math.min(100, meter.percent ?? 0);
  const tone = pct >= 100 ? 'bg-destructive' : pct >= 80 ? 'bg-warning' : 'bg-primary';
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
      </div>
      <div className="grid gap-3">
        <MeterRow label={t('shortVideos')} meter={usage.videos.short} />
        {usage.videos.long.limit !== 0 && (
          <MeterRow label={t('longVideos')} meter={usage.videos.long} />
        )}
      </div>
    </section>
  );
}
