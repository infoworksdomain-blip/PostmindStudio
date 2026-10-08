'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronRight, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { useBusiness } from '../business-context';
import { EmptyState, ErrorState, PageHeader, StateBadge } from '../primitives';
import { WriteGate } from '../write-gate';
import { statusTone, type AutomationSummary } from './automation-model';

// 22.5 — /automations: the business's automations, newest first. 25.9: a calm list — name,
// status pill, what it makes (cadence, length, approval) and when its next post goes out
// (GET /automations nextPostAt) — one row per automation, the whole row opening its page.

export function CadenceText({ cadence }: { cadence: AutomationSummary['cadence'] }) {
  const t = useTranslations('automations.cadence');
  return (
    <>
      {cadence.mode === 'per_day'
        ? t('perDay', { count: cadence.postsPerDay })
        : t('perWeek', { count: cadence.postsPerWeek })}
    </>
  );
}

/** "Next post" for one automation: its time, or why there is none. */
export function NextPostText({ automation }: { automation: AutomationSummary }) {
  const t = useTranslations('automations.list');
  const f = useFormat();
  if (automation.nextPostAt)
    return (
      <time dateTime={automation.nextPostAt}>
        {f.date(automation.nextPostAt, {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          hour: 'numeric',
          minute: '2-digit',
        })}
      </time>
    );
  if (automation.status === 'REVIEW') return <>{t('next.review')}</>;
  if (automation.status === 'PAUSED') return <>{t('next.paused')}</>;
  if (automation.status === 'DRAFT') return <>{t('next.draft')}</>;
  return <>{t('next.none')}</>;
}

export function AutomationsList() {
  const t = useTranslations('automations');
  const tn = useTranslations('shell.nav.groups');
  const { businessId, ready } = useBusiness();
  const { data, error, mutate } = useApi<{ automations: AutomationSummary[] }>(
    businessId ? '/automations' : null,
    { businessId },
  );
  const create = (
    <WriteGate>
      <Button asChild>
        <Link href="/automations/new">
          <Plus /> {t('list.new')}
        </Link>
      </Button>
    </WriteGate>
  );
  return (
    <>
      <PageHeader
        eyebrow={tn('plan')}
        title={t('list.title')}
        description={t('list.description')}
        actions={create}
      />
      {ready && !businessId && (
        <EmptyState media="business" title={t('list.pickTitle')} description={t('list.pickBody')} />
      )}
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {businessId && !data && !error && (
        <Skeleton aria-label={t('list.loading')} className="h-40 rounded-panel" />
      )}
      {data && data.automations.length === 0 && (
        <EmptyState title={t('list.empty')} description={t('list.emptyBody')} action={create} />
      )}
      {data && data.automations.length > 0 && (
        <div className="overflow-hidden rounded-panel border border-border bg-card">
          <div
            aria-hidden
            className="hidden grid-cols-[minmax(0,2fr)_8rem_minmax(0,2fr)_minmax(0,1.3fr)_1.25rem] gap-4 border-b border-border px-5 py-2.5 text-xs font-medium text-muted-foreground md:grid"
          >
            <span>{t('list.columns.name')}</span>
            <span>{t('list.columns.status')}</span>
            <span>{t('list.columns.makes')}</span>
            <span>{t('list.columns.next')}</span>
            <span />
          </div>
          <ul aria-label={t('list.title')} className="divide-y divide-border">
            {data.automations.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/automations/${a.id}`}
                  className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-5 py-4 transition-colors duration-(--duration-fast) hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset md:grid-cols-[minmax(0,2fr)_8rem_minmax(0,2fr)_minmax(0,1.3fr)_1.25rem]"
                >
                  <span className="min-w-0 truncate font-medium">{a.name}</span>
                  <span className="justify-self-end md:justify-self-start">
                    <StateBadge label={t(`status.${a.status}`)} tone={statusTone(a.status)} />
                  </span>
                  <span className="col-span-2 text-sm text-muted-foreground md:col-span-1">
                    <CadenceText cadence={a.cadence} /> · {t(`duration.${a.duration}`)} ·{' '}
                    {t(`approval.${a.approvalMode}`)}
                  </span>
                  <span className="tabular col-span-2 text-sm md:col-span-1">
                    <span className="text-muted-foreground md:sr-only">
                      {t('list.columns.next')}:{' '}
                    </span>
                    <NextPostText automation={a} />
                  </span>
                  <ChevronRight
                    aria-hidden
                    className="hidden size-4 text-muted-foreground group-hover:text-foreground md:block rtl:-scale-x-100"
                  />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
