'use client';

import Link from 'next/link';
import { Download, ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { useApi } from '@/lib/client/api';
import { safeHttpUrl, useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { MeterRow, type UsageResponse } from '../usage-meter';
import { Section, StateBadge } from '../primitives';
import { channelList } from './channel-labels';
import { usePackName } from './channel-picker';
import type { CheckoutIntent } from './use-billing-actions';
import type { BillingResponse, InvoicesResponse, PricingView } from './types';

// Phase 18 §3 / 21.5 Your plan (/settings/billing) — videos used against the allowance, the
// connected channels, seats / businesses / storage, the HD video packs and the Stripe invoices.
// No generation cost is shown to customers.

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

/** 21.5: videos used against the plan's allowance this week / month, and pack videos left. */
export function AllowanceSection({ billing }: { billing: Billing }) {
  const t = useTranslations('billing.yourPlan.videos');
  const tUsage = useTranslations('shell.usage');
  const f = useFormat();
  const usage = useApi<UsageResponse>('/usage');
  const u = usage.data?.usage;
  const period = u?.period ?? 'month';
  return (
    <Section title={t('title', { period })} description={t('description')}>
      <div className="grid gap-4 text-sm">
        {u ? (
          <>
            <MeterRow label={t('used', { period })} meter={u.videos.short} />
            <p className="text-muted-foreground">
              {t('moreFrom', {
                date: f.date(u.resetsAt, { day: 'numeric', month: 'long', timeZone: 'UTC' }),
              })}
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

/** 21.5: the connected platforms against the paid channels. */
export function ChannelsSection({ billing }: { billing: Billing }) {
  const t = useTranslations('billing.yourPlan.channels');
  const usage = billing.channels;
  if (!usage) return null;
  return (
    <Section title={t('title')} description={t('description', { count: usage.paid })}>
      <div className="grid gap-2 text-sm">
        {usage.connected.length === 0 ? (
          <p className="text-muted-foreground">
            {t('noneConnected')}{' '}
            <Link className="font-medium underline underline-offset-4" href="/connections">
              {t('connect')}
            </Link>
          </p>
        ) : (
          <p>{t('publishing', { list: channelList(usage.allowed) })}</p>
        )}
        {usage.blocked.length > 0 && (
          <p role="alert" className="rounded-md border border-warning/50 bg-warning/10 p-3">
            {t('blocked', { list: channelList(usage.blocked), count: usage.blocked.length })}{' '}
            <a className="font-medium underline underline-offset-4" href="#change">
              {t('addChannel')}
            </a>
          </p>
        )}
        {usage.connected.length > 0 && usage.connected.length < usage.paid && (
          <p className="text-muted-foreground">
            {t('spare', { count: usage.paid - usage.connected.length })}
          </p>
        )}
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
          <p className="rounded-md bg-warning/10 p-2 text-xs">{t('storageOver')}</p>
        )}
      </div>
    </Section>
  );
}

/** 21.5: one-off HD video packs, any channel, valid 3 months. */
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
  const tp = useTranslations('channelPlan');
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

type Invoice = InvoicesResponse['invoices'][number];

export function InvoicesSection({ enabled }: { enabled: boolean }) {
  const t = useTranslations('billing.invoices');
  const f = useFormat();
  const res = useApi<InvoicesResponse>(enabled ? '/billing/invoices' : null, { limit: 12 });
  const invoices = res.data?.invoices ?? [];
  const numberOf = (invoice: Invoice) => invoice.number ?? t('draft');
  const columns: Array<DataTableColumn<Invoice>> = [
    {
      id: 'number',
      header: t('number'),
      className: 'font-medium',
      cell: (invoice) => numberOf(invoice),
    },
    {
      id: 'date',
      header: t('date'),
      cell: (invoice) => f.date(invoice.createdAt, { dateStyle: 'medium' }),
    },
    {
      id: 'amount',
      header: t('amount'),
      align: 'end',
      className: 'tabular-nums',
      cell: (invoice) => f.pence(invoice.amountDuePence),
    },
    {
      id: 'status',
      header: t('status'),
      cell: (invoice) =>
        isInvoiceStatus(invoice.status) ? (
          <StateBadge label={t(`statuses.${invoice.status}`)} tone={INVOICE_TONE[invoice.status]} />
        ) : (
          invoice.status
        ),
    },
    {
      id: 'links',
      header: <span className="sr-only">{t('links')}</span>,
      mobileLabel: t('links'),
      align: 'end',
      cell: (invoice) => <InvoiceLinks invoice={invoice} number={numberOf(invoice)} />,
    },
  ];
  return (
    <Section title={t('title')}>
      {invoices.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <DataTable
          caption={t('caption')}
          columns={columns}
          rows={invoices}
          getRowId={(invoice) => invoice.id}
          responsive="stack"
        />
      )}
    </Section>
  );
}

function InvoiceLinks({ invoice, number }: { invoice: Invoice; number: string }) {
  const t = useTranslations('billing.invoices');
  const hosted = safeHttpUrl(invoice.hostedInvoiceUrl);
  const pdf = safeHttpUrl(invoice.invoicePdfUrl);
  return (
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
  );
}
