'use client';

import { CreditCard, Download, ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { useApi } from '@/lib/client/api';
import { safeHttpUrl, useFormat } from '@/lib/client/format';
import { Section, StateBadge } from '../primitives';
import type { BillingResponse, InvoicesResponse } from './types';

// 21.5 / 25.12 — payment method and invoices in one place: the Stripe Customer Portal (card,
// billing address, tax ID) and the last 12 invoices with their links. Nothing else is managed in
// the portal.

type Billing = BillingResponse['billing'];

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

function InvoicesTable({ enabled }: { enabled: boolean }) {
  const t = useTranslations('billing.invoices');
  const f = useFormat();
  const res = useApi<InvoicesResponse>(enabled ? '/billing/invoices' : null, { limit: 12 });
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
      sortValue: (invoice) => invoice.createdAt,
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
    <div className="grid gap-3">
      <h3 className="text-sm font-semibold">{t('title')}</h3>
      <DataTable
        caption={t('caption')}
        columns={columns}
        rows={enabled ? res.data?.invoices : []}
        loading={enabled && !res.data && !res.error}
        getRowId={(invoice) => invoice.id}
        empty={<span className="text-muted-foreground">{t('empty')}</span>}
        responsive="stack"
      />
    </div>
  );
}

export function PaymentSection({
  billing,
  pending,
  onPortal,
}: {
  billing: Billing;
  pending: string | null;
  onPortal: () => void;
}) {
  const t = useTranslations('billing.plan');
  const enabled = billing.hasBillingAccount && billing.checkoutEnabled;
  const canPortal = billing.canManage && enabled;
  return (
    <Section
      id="payment"
      title={t('detailsTitle')}
      description={canPortal ? t('manageHelp') : undefined}
      actions={
        canPortal ? (
          <Button
            variant="outline"
            onClick={onPortal}
            disabled={pending !== null}
            loading={pending === 'portal'}
          >
            {pending !== 'portal' && <CreditCard />}
            {t('manage')}
          </Button>
        ) : undefined
      }
    >
      <InvoicesTable enabled={enabled} />
    </Section>
  );
}
