'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { MeterRow, meterFillClass, type UsageResponse } from '../usage-meter';
import { Section } from '../primitives';
import { allowanceLeft } from './plan-summary';
import { usePackName } from './plan-picker';
import type { CheckoutIntent } from './use-billing-actions';
import type { BillingResponse, PricingView } from './types';

// Phase 18 §3 / 26.1 Your plan (/settings/billing) — videos used against the allowance, seats /
// businesses / storage, the HD video packs and the Stripe invoices.
// No generation cost is shown to customers.

type Billing = BillingResponse['billing'];

const GB = 1024 ** 3;

/** A thin meter for values MeterRow cannot show (storage in GB, money). */
function Meter({ label, text, percent }: { label: string; text: string; percent: number | null }) {
  const pct = Math.min(100, Math.max(0, percent ?? 0));
  const tone = meterFillClass(pct);
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">{text}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuetext={text}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : Math.round(pct)}
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

function countMeter(meter: { used: number; limit: number | null }) {
  return {
    used: meter.used,
    limit: meter.limit,
    percent: meter.limit ? Math.round((meter.used / meter.limit) * 100) : null,
    maxDurationSec: null,
  };
}

/**
 * 21.5: videos used against the plan's allowance this week / month, what is left (25.12: "0 left"
 * is shown, never hidden) and pack videos left.
 */
export function AllowanceSection({
  billing,
  usage: u,
}: {
  billing: Billing;
  usage: UsageResponse['usage'] | undefined;
}) {
  const t = useTranslations('billing.yourPlan.videos');
  const tUsage = useTranslations('shell.usage');
  const f = useFormat();
  const period = u?.period ?? 'month';
  const left = u ? allowanceLeft(u.videos.short) : null;
  return (
    <Section title={t('title', { period })} description={t('description')}>
      <div className="grid max-w-2xl gap-4 text-sm">
        {u ? (
          <>
            <MeterRow label={t('used', { period })} meter={u.videos.short} />
            <p className="flex flex-wrap gap-x-3 gap-y-1">
              {left !== null && (
                <span className="font-medium">
                  {t('left', { left: f.number(left, { maximumFractionDigits: 2 }) })}
                </span>
              )}
              <span className="text-muted-foreground">
                {t('moreFrom', {
                  date: f.date(u.resetsAt, { day: 'numeric', month: 'long', timeZone: 'UTC' }),
                })}
              </span>
            </p>
          </>
        ) : (
          <div className="h-10" aria-hidden />
        )}
        <p>{t('packsLeft', { count: billing.credits.short })}</p>
        <p className="text-muted-foreground">{tUsage('quickPostsNote')}</p>
      </div>
    </Section>
  );
}

/** Seats, businesses and storage (no cost or budget figures for customers, 21.5). */
export function UsageSection({ billing }: { billing: Billing }) {
  const t = useTranslations('billing.usage');
  const f = useFormat();
  const { storage, seats, businesses } = billing.usage;
  const usedGb = f.number(Number(storage.usedBytes) / GB, { maximumFractionDigits: 1 });
  const storageText =
    storage.limitGb === null
      ? t('storageUnlimited', { used: usedGb })
      : t('storageUsed', { used: usedGb, limit: f.number(storage.limitGb) });
  return (
    <Section title={t('title')} description={t('descriptionLimits')}>
      <div className="grid gap-5">
        <MeterRow label={t('seats')} meter={countMeter(seats)} />
        <MeterRow label={t('businesses')} meter={countMeter(businesses)} />
        <Meter label={t('storage')} text={storageText} percent={storage.percent} />
        {storage.percent !== null && storage.percent >= 100 && (
          <p className="rounded-field bg-warning-soft p-2.5 text-xs text-warning-foreground">
            {t('storageOver')}
          </p>
        )}
      </div>
    </Section>
  );
}

/** 21.5: one-off HD video packs, any plan, valid 3 months. */
export function TopUpsSection({
  billing,
  pricing,
  pending,
  onBuy,
}: {
  billing: Billing;
  pricing: PricingView | undefined;
  pending: string | null;
  onBuy: (intent: CheckoutIntent, pendingKey: string) => void;
}) {
  const t = useTranslations('billing.credits');
  const tp = useTranslations('planPicker');
  const f = useFormat();
  const name = usePackName();
  // Packs need a plan to spend them on; none without one.
  const packs = billing.entitlements.access === 'none' ? [] : (pricing?.topUps ?? []);
  const canBuy = billing.canManage && billing.checkoutEnabled;
  return (
    <section id="topups" className="scroll-mt-20">
      <Section title={t('title')} description={t('description')}>
        <div className="grid gap-4">
          <p className="text-sm">{t('videosLeft', { count: billing.credits.short })}</p>
          {packs.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noPacks')}</p>
          ) : (
            <ul className="grid max-w-2xl divide-y divide-border border-y border-border">
              {packs.map((pack) => {
                const amount = pack.unitAmountPence === null ? null : f.pence(pack.unitAmountPence);
                return (
                  <li key={pack.lookupKey} className="flex items-center justify-between gap-3 py-3">
                    <div className="grid gap-0.5 text-sm">
                      <span className="font-medium">{name(pack)}</span>
                      <span className="text-muted-foreground">
                        {amount ?? tp('priceUnavailable')}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {tp('packs.validity', { months: pack.validMonths })}
                      </span>
                    </div>
                    {canBuy && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={amount === null || pending !== null}
                        aria-label={
                          amount === null ? undefined : t('buyAria', { pack: name(pack), amount })
                        }
                        loading={pending === pack.lookupKey}
                        onClick={() =>
                          onBuy({ kind: 'topup', lookupKey: pack.lookupKey }, pack.lookupKey)
                        }
                      >
                        {t('buy')}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Section>
    </section>
  );
}
