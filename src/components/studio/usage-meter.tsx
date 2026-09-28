'use client';

import { Gauge } from 'lucide-react';
import { useApi } from '@/lib/client/api';
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

const TIER_LABEL: Record<UsageResponse['usage']['planTier'], string> = {
  BASIC: 'Basic',
  STANDARD: 'Standard',
  PLUS: 'Plus',
  ENTERPRISE: 'Enterprise',
};

function resetDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function limitText(m: QuotaMeterView): string {
  if (m.limit === null) return `${m.used} (unlimited)`;
  return `${m.used} of ${m.limit}`;
}

export function MeterRow({ label, meter }: { label: string; meter: QuotaMeterView }) {
  const pct = meter.limit === null ? 0 : Math.min(100, meter.percent ?? 0);
  const tone = pct >= 100 ? 'bg-destructive' : pct >= 80 ? 'bg-warning' : 'bg-primary';
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">{limitText(meter)}</span>
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
  const short = usage.videos.short.maxDurationSec;
  const long = usage.videos.long.maxDurationSec;
  return (
    <div className="grid gap-4">
      <MeterRow
        label={`Short videos${short ? ` (up to ${short} s)` : ''}`}
        meter={usage.videos.short}
      />
      <MeterRow
        label={`Long videos${long ? ` (up to ${Math.round(long / 60)} min)` : ''}`}
        meter={usage.videos.long}
      />
      <p className="text-xs text-muted-foreground">
        {TIER_LABEL[usage.planTier]} plan · {usage.platforms.description} · website scans for{' '}
        {usage.scans.businessesScanned} of {usage.scans.limit ?? 'unlimited'} businesses · resets{' '}
        {resetDate(usage.resetsAt)} ·{' '}
        {usage.mode === 'enforce' ? 'limits enforced' : 'limits not enforced yet'}
      </p>
    </div>
  );
}

/** App-shell banner: rendered only once a monthly quota reaches 80 %. */
export function UsageBanner() {
  const res = useApi<UsageResponse>('/usage');
  const usage = res.data?.usage;
  if (!usage || usage.status === 'ok') return null;
  const exceeded = usage.status === 'exceeded';
  const blocked = exceeded && usage.mode === 'enforce';
  return (
    <section
      role="status"
      aria-label="Plan usage"
      className={cn(
        'mb-6 grid gap-4 rounded-xl border p-4 md:grid-cols-[auto_1fr_minmax(14rem,20rem)] md:items-center',
        exceeded ? 'border-destructive/40 bg-destructive/5' : 'border-warning/50 bg-warning/10',
      )}
    >
      <Gauge className="size-6 text-muted-foreground" strokeWidth={1.5} aria-hidden />
      <div className="text-sm">
        <p className="font-medium">
          {exceeded
            ? `You’ve used this month’s ${TIER_LABEL[usage.planTier]} plan videos`
            : `You’re close to this month’s ${TIER_LABEL[usage.planTier]} plan limit`}
        </p>
        <p className="text-muted-foreground">
          {blocked
            ? `New videos are paused until ${resetDate(usage.resetsAt)}. Upgrade your plan to keep creating.`
            : `The allowance resets on ${resetDate(usage.resetsAt)}. Upgrade your plan for more videos.`}
        </p>
      </div>
      <div className="grid gap-3">
        <MeterRow label="Short videos" meter={usage.videos.short} />
        {usage.videos.long.limit !== 0 && (
          <MeterRow label="Long videos" meter={usage.videos.long} />
        )}
      </div>
    </section>
  );
}
