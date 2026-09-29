'use client';

import { Download, ExternalLink, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useApi } from '@/lib/client/api';
import { safeHttpUrl, useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { MeterRow, UsageMeters, type UsageResponse } from '../usage-meter';
import { Section, StateBadge } from '../primitives';
import { useTopUpName } from './plan-cards';
import type { CheckoutIntent } from './use-billing-actions';
import type { BillingResponse, InvoicesResponse, PricingView } from './types';

// Phase 18 §3 /settings/billing — usage against every plan limit, top-up credits and packs, and
// the Stripe invoice list.

type Billing = BillingResponse['billing'];

const GB = 1024 ** 3;

/** A thin meter for values MeterRow cannot show (storage in GB, money). */
function Meter({ label, text, percent }: { label: string; text: string; percent: number | null }) {
  const pct = Math.min(100, Math.max(0, percent ?? 0));
  const tone = pct >= 100 ? 'bg-destructive' : pct >= 80 ? 'bg-warning' : 'bg-primary';
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

export function UsageSection({ billing }: { billing: Billing }) {
  const t = useTranslations('billing.usage');
  const f = useFormat();
  const usage = useApi<UsageResponse>('/usage');
  const { storage, cost, seats, businesses } = billing.usage;
  const usedGb = f.number(Number(storage.usedBytes) / GB, { maximumFractionDigits: 1 });
  const storageText =
    storage.limitGb === null
      ? t('storageUnlimited', { used: usedGb })
      : t('storageUsed', { used: usedGb, limit: f.number(storage.limitGb) });
  const costText =
    cost.capPence === null
      ? t('costNoCap', { spent: f.pence(cost.spentPence) })
      : t('costOf', { spent: f.pence(cost.spentPence), cap: f.pence(cost.capPence) });
  const costPercent = cost.capPence ? Math.round((cost.spentPence / cost.capPence) * 100) : null;
  return (
    <Section title={t('title')} description={t('description')}>
      <div className="grid gap-5">
        {usage.data && <UsageMeters usage={usage.data.usage} />}
        <MeterRow label={t('seats')} meter={countMeter(seats)} />
        <MeterRow label={t('businesses')} meter={countMeter(businesses)} />
        <Meter label={t('storage')} text={storageText} percent={storage.percent} />
        {storage.percent !== null && storage.percent >= 100 && (
          <p className="rounded-md bg-warning/10 p-2 text-xs">{t('storageOver')}</p>
        )}
        <Meter label={t('cost')} text={costText} percent={costPercent} />
        {cost.headroomPence > 0 && (
          <p className="text-xs text-muted-foreground">
            {t('costHeadroom', { amount: f.pence(cost.headroomPence) })}
          </p>
        )}
      </div>
    </Section>
  );
}

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
  const tp = useTranslations('pricing');
  const f = useFormat();
  const name = useTopUpName();
  const { tier, access } = billing.entitlements;
  // Only packs for the organisation's own tier (BASIC has no long pack); none without a plan.
  const packs =
    access === 'none' ? [] : (pricing?.topUps ?? []).filter((pack) => pack.tier === tier);
  const canBuy = billing.canManage && billing.checkoutEnabled;
  return (
    <section id="topups" className="scroll-mt-20">
      <Section title={t('title')} description={t('description')}>
        <div className="grid gap-4">
          <ul className="grid gap-1 text-sm">
            <li>{t('short', { count: billing.credits.short })}</li>
            <li>{t('long', { count: billing.credits.long })}</li>
          </ul>
          {packs.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noPacks')}</p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {packs.map((pack) => {
                const amount = pack.unitAmountPence === null ? null : f.pence(pack.unitAmountPence);
                return (
                  <li
                    key={pack.lookupKey}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
                  >
                    <div className="grid gap-0.5 text-sm">
                      <span className="font-medium">{name(pack)}</span>
                      <span className="text-muted-foreground">
                        {amount ?? tp('priceUnavailable')}
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
                        onClick={() =>
                          onBuy({ kind: 'topup', lookupKey: pack.lookupKey }, pack.lookupKey)
                        }
                      >
                        {pending === pack.lookupKey && <Loader2 className="animate-spin" />}
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

const INVOICE_STATUSES = ['draft', 'open', 'paid', 'uncollectible', 'void'] as const;
type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
const isInvoiceStatus = (s: string): s is InvoiceStatus =>
  (INVOICE_STATUSES as readonly string[]).includes(s);
const INVOICE_TONE = {
  draft: 'neutral',
  open: 'warn',
  paid: 'good',
  uncollectible: 'bad',
  void: 'neutral',
} as const satisfies Record<InvoiceStatus, string>;

export function InvoicesSection({ enabled }: { enabled: boolean }) {
  const t = useTranslations('billing.invoices');
  const f = useFormat();
  const res = useApi<InvoicesResponse>(enabled ? '/billing/invoices' : null, { limit: 12 });
  const invoices = res.data?.invoices ?? [];
  return (
    <Section title={t('title')}>
      {invoices.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        // relative: the sr-only caption and labels (absolutely positioned) stay inside the scroll
        // box; otherwise they widen right-to-left pages on phones.
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[32rem] text-sm">
            <caption className="sr-only">{t('caption')}</caption>
            <thead>
              <tr className="text-muted-foreground">
                <th scope="col" className="py-2 pe-3 text-start font-medium">
                  {t('number')}
                </th>
                <th scope="col" className="py-2 pe-3 text-start font-medium">
                  {t('date')}
                </th>
                <th scope="col" className="py-2 pe-3 text-end font-medium">
                  {t('amount')}
                </th>
                <th scope="col" className="py-2 pe-3 text-start font-medium">
                  {t('status')}
                </th>
                <th scope="col" className="py-2 text-end font-medium">
                  <span className="sr-only">{t('links')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => {
                const number = invoice.number ?? t('draft');
                const hosted = safeHttpUrl(invoice.hostedInvoiceUrl);
                const pdf = safeHttpUrl(invoice.invoicePdfUrl);
                return (
                  <tr key={invoice.id} className="border-t border-border">
                    <td className="py-2 pe-3 font-medium">{number}</td>
                    <td className="py-2 pe-3">
                      {f.date(invoice.createdAt, { dateStyle: 'medium' })}
                    </td>
                    <td className="py-2 pe-3 text-end tabular-nums">
                      {f.pence(invoice.amountDuePence)}
                    </td>
                    <td className="py-2 pe-3">
                      {isInvoiceStatus(invoice.status) ? (
                        <StateBadge
                          label={t(`statuses.${invoice.status}`)}
                          tone={INVOICE_TONE[invoice.status]}
                        />
                      ) : (
                        invoice.status
                      )}
                    </td>
                    <td className="py-2">
                      <div className="flex justify-end gap-1">
                        {hosted && (
                          <Button asChild size="sm" variant="ghost">
                            <a
                              href={hosted}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={t('viewAria', { number })}
                            >
                              <ExternalLink aria-hidden /> {t('view')}
                            </a>
                          </Button>
                        )}
                        {pdf && (
                          <Button asChild size="sm" variant="ghost">
                            <a
                              href={pdf}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={t('pdfAria', { number })}
                            >
                              <Download aria-hidden /> {t('pdf')}
                            </a>
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
