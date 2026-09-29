'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Check, Mail, Minus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/client/format';
import type { PlanDefinition } from '@/lib/studio/billing/catalogue';
import { PageHeader } from '../primitives';
import { IntervalToggle, PlanCards, useTopUpName } from './plan-cards';
import type { BillingInterval, PlanPricingView, PricingView } from './types';

// Phase 18 §3 / §P.4 — /pricing: tier cards with a monthly / annual switch (annual shows the
// saving), "excl. VAT", the trial note, the comparison table built from the plan catalogue (the
// same data the server gates read), top-up packs and an FAQ. Amounts come from Stripe through
// PricingView; when Stripe is unreachable every amount reads "price unavailable".

type RowKey =
  | 'shortVideos'
  | 'longVideos'
  | 'platforms'
  | 'dailyCostCap'
  | 'monthlyCostCap'
  | 'queuePriority'
  | 'musicAndSfx'
  | 'voiceClone'
  | 'renders4k'
  | 'imageLibrary'
  | 'generatedImages'
  | 'scanBusinesses'
  | 'libraryInspire'
  | 'libraryTemplate'
  | 'customPresets'
  | 'approvalWorkflows'
  | 'byocProviderKeys'
  | 'whiteLabel'
  | 'dnsDomainVerification'
  | 'seats'
  | 'businesses'
  | 'storage';

type Cell = { kind: 'bool'; on: boolean } | { kind: 'text'; text: string } | { kind: 'unlimited' };

type BoolFlag =
  | 'musicAndSfx'
  | 'voiceClone'
  | 'renders4k'
  | 'libraryInspire'
  | 'libraryTemplate'
  | 'customPresets'
  | 'approvalWorkflows'
  | 'byocProviderKeys'
  | 'whiteLabel'
  | 'dnsDomainVerification';

const BOOL_ROWS: readonly BoolFlag[] = [
  'musicAndSfx',
  'voiceClone',
  'renders4k',
  'libraryInspire',
  'libraryTemplate',
  'customPresets',
  'approvalWorkflows',
  'byocProviderKeys',
  'whiteLabel',
  'dnsDomainVerification',
];

const ROW_ORDER: readonly RowKey[] = [
  'shortVideos',
  'longVideos',
  'platforms',
  'dailyCostCap',
  'monthlyCostCap',
  'queuePriority',
  'musicAndSfx',
  'voiceClone',
  'renders4k',
  'imageLibrary',
  'generatedImages',
  'scanBusinesses',
  'libraryInspire',
  'libraryTemplate',
  'customPresets',
  'approvalWorkflows',
  'byocProviderKeys',
  'whiteLabel',
  'dnsDomainVerification',
  'seats',
  'businesses',
  'storage',
];

function isBoolRow(key: RowKey): key is BoolFlag {
  return (BOOL_ROWS as readonly string[]).includes(key);
}

function useCell(): (key: RowKey, p: PlanDefinition) => Cell {
  const t = useTranslations('pricing.compare.values');
  const f = useFormat();
  const count = (n: number | null): Cell =>
    n === null ? { kind: 'unlimited' } : { kind: 'text', text: f.number(n) };
  return (key, p) => {
    if (isBoolRow(key)) return { kind: 'bool', on: p[key] };
    switch (key) {
      case 'shortVideos':
        return count(p.shortVideosPerMonth);
      case 'longVideos':
        if (p.longVideosPerMonth === null) return { kind: 'unlimited' };
        if (!p.longVideosPerMonth) return { kind: 'bool', on: false };
        return {
          kind: 'text',
          text: t('longVideos', {
            count: p.longVideosPerMonth,
            minutes: Math.round((p.longMaxSec ?? 0) / 60),
          }),
        };
      case 'platforms':
        return { kind: 'text', text: t(`platforms.${p.platforms}`) };
      case 'dailyCostCap':
        return { kind: 'text', text: f.pence(p.dailyCostCapPence) };
      case 'monthlyCostCap':
        return { kind: 'text', text: f.pence(p.monthlyCostCapPence) };
      case 'queuePriority':
        return { kind: 'text', text: t(`queuePriority.${p.queuePriority}`) };
      case 'imageLibrary':
        return { kind: 'text', text: t(`imageLibrary.${p.imageLibrary}`) };
      case 'generatedImages':
        return count(p.generatedImagesPerBusinessPerMonth);
      case 'scanBusinesses':
        return count(p.scanBusinesses);
      case 'seats':
        return count(p.seats);
      case 'businesses':
        return count(p.businesses);
      case 'storage':
        return p.storageGb === null
          ? { kind: 'unlimited' }
          : { kind: 'text', text: t('storage', { gb: f.number(p.storageGb) }) };
    }
  };
}

function CellView({ cell }: { cell: Cell }) {
  const t = useTranslations('pricing.compare');
  if (cell.kind === 'text') return <>{cell.text}</>;
  if (cell.kind === 'unlimited') return <>{t('unlimited')}</>;
  return cell.on ? (
    <>
      <Check className="inline size-4 text-primary" aria-hidden />
      <span className="sr-only">{t('included')}</span>
    </>
  ) : (
    <>
      <Minus className="inline size-4 text-muted-foreground" aria-hidden />
      <span className="sr-only">{t('notIncluded')}</span>
    </>
  );
}

export function ComparisonTable({ plans }: { plans: readonly PlanPricingView[] }) {
  const t = useTranslations('pricing.compare');
  const tTier = useTranslations('shell.usage.tiers');
  const cellFor = useCell();
  const sorted = [...plans].sort((a, b) => a.displayOrder - b.displayOrder);
  return (
    <section aria-labelledby="compare-heading" className="grid gap-4">
      <h2 id="compare-heading" className="font-display text-3xl leading-none">
        {t('title')}
      </h2>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[40rem] text-sm">
          <caption className="sr-only">{t('caption')}</caption>
          <thead className="bg-muted/50">
            <tr>
              <th scope="col" className="px-4 py-3 text-start font-medium">
                {t('feature')}
              </th>
              {sorted.map((plan) => (
                <th key={plan.tier} scope="col" className="px-4 py-3 text-start font-medium">
                  {tTier(plan.tier)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROW_ORDER.map((key) => (
              <tr key={key} className="border-t border-border">
                <th
                  scope="row"
                  className="px-4 py-2.5 text-start font-normal text-muted-foreground"
                >
                  {t(`rows.${key}`)}
                </th>
                {sorted.map((plan) => (
                  <td key={plan.tier} className="px-4 py-2.5 tabular-nums">
                    <CellView cell={cellFor(key, plan.features)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TopUpList({ pricing }: { pricing: PricingView }) {
  const t = useTranslations('pricing');
  const tTier = useTranslations('shell.usage.tiers');
  const f = useFormat();
  const name = useTopUpName();
  return (
    <section aria-labelledby="topups-heading" className="grid gap-4">
      <div className="grid gap-1.5">
        <h2 id="topups-heading" className="font-display text-3xl leading-none">
          {t('topUps.title')}
        </h2>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('topUps.description')}</p>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {pricing.topUps.map((pack) => (
          <li key={pack.lookupKey} className="grid gap-1 rounded-xl border border-border p-4">
            <p className="font-medium">{name(pack)}</p>
            <p className="text-xs text-muted-foreground">
              {t('topUps.forTier', { tier: tTier(pack.tier) })}
            </p>
            <p className="font-display text-2xl tabular-nums">
              {pack.unitAmountPence === null
                ? t('priceUnavailable')
                : f.pence(pack.unitAmountPence)}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('topUps.validity', { months: pack.validMonths })}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

const FAQ = ['trial', 'change', 'limit', 'vat', 'cancel'] as const;

function Faq() {
  const t = useTranslations('pricing.faq');
  return (
    <section aria-labelledby="faq-heading" className="grid gap-4">
      <h2 id="faq-heading" className="font-display text-3xl leading-none">
        {t('title')}
      </h2>
      <div className="divide-y divide-border rounded-xl border border-border">
        {FAQ.map((item) => (
          <details key={item} className="group p-4">
            <summary className="cursor-pointer font-medium">{t(`items.${item}.q`)}</summary>
            <p className="mt-2 text-sm text-muted-foreground">{t(`items.${item}.a`)}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

function SignUpCta({ plan, interval }: { plan: PlanPricingView; interval: BillingInterval }) {
  const t = useTranslations('pricing.cta');
  const tTier = useTranslations('shell.usage.tiers');
  const href = `/sign-up?plan=${plan.tier}&interval=${interval}`;
  const trial = plan.trialDays > 0;
  return (
    <Button asChild className="w-full" variant={trial ? 'default' : 'outline'}>
      <Link
        href={href}
        aria-label={trial ? undefined : t('chooseAria', { tier: tTier(plan.tier) })}
      >
        {trial ? t('trial') : t('choose')}
        <ArrowRight className="rtl:-scale-x-100" aria-hidden />
      </Link>
    </Button>
  );
}

function EnterpriseCta({ salesEmail }: { salesEmail?: string | null }) {
  const t = useTranslations('pricing.enterprise');
  if (!salesEmail) return <p className="text-sm text-muted-foreground">{t('noContact')}</p>;
  return (
    <Button asChild className="w-full" variant="outline">
      <a href={`mailto:${salesEmail}`} aria-label={t('contactAria')}>
        <Mail aria-hidden /> {t('contact')}
      </a>
    </Button>
  );
}

export function PricingScreen({
  pricing,
  salesEmail,
}: {
  pricing: PricingView;
  salesEmail?: string | null;
}) {
  const t = useTranslations('pricing');
  const tTier = useTranslations('shell.usage.tiers');
  const [interval, setBillingInterval] = useState<BillingInterval>('month');
  return (
    <div className="mx-auto grid w-full max-w-7xl gap-12 px-4 py-10 md:px-8 md:py-16">
      <PageHeader
        eyebrow={t('hero.eyebrow')}
        title={t('hero.title')}
        description={t('hero.description')}
        actions={<IntervalToggle value={interval} onChange={setBillingInterval} />}
      />
      <div className="grid gap-6">
        {!pricing.available && (
          <p
            role="status"
            className="rounded-xl border border-warning/50 bg-warning/10 p-4 text-sm"
          >
            {t('unavailable')}
          </p>
        )}
        <PlanCards
          plans={pricing.plans}
          interval={interval}
          cta={(plan) =>
            plan.selfServe ? (
              <SignUpCta plan={plan} interval={interval} />
            ) : (
              <EnterpriseCta salesEmail={salesEmail} />
            )
          }
        />
        <div className="grid gap-1 text-sm text-muted-foreground">
          <p>{t('exclVat')}</p>
          {pricing.trial.days > 0 && (
            <p>
              {t('trialNote', {
                tier: tTier(pricing.trial.tier),
                days: pricing.trial.days,
                short: pricing.trial.shortVideos,
                long: pricing.trial.longVideos,
              })}
            </p>
          )}
        </div>
      </div>
      <ComparisonTable plans={pricing.plans} />
      <TopUpList pricing={pricing} />
      <Faq />
    </div>
  );
}
