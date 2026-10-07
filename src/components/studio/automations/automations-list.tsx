'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Plus, Repeat } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { useBusiness } from '../business-context';
import { EmptyState, ErrorState, PageHeader, StateBadge } from '../primitives';
import { WriteGate } from '../write-gate';
import { statusTone, type AutomationSummary } from './automation-model';

// 22.5 — /automations: the business's automations, newest first.

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
        <Skeleton aria-label={t('list.loading')} className="h-40 rounded-xl" />
      )}
      {data && data.automations.length === 0 && (
        <EmptyState title={t('list.empty')} description={t('list.emptyBody')} action={create} />
      )}
      {data && data.automations.length > 0 && (
        <ul className="grid gap-3 md:grid-cols-2">
          {data.automations.map((a) => (
            <li key={a.id}>
              <Link
                href={`/automations/${a.id}`}
                className="group flex h-full flex-col gap-3 rounded-2xl border border-border bg-card p-5 shadow-xs transition hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transform-none"
              >
                <span className="flex items-start justify-between gap-3">
                  <span className="flex items-center gap-2 font-medium">
                    <Repeat className="size-4 text-primary" aria-hidden />
                    {a.name}
                  </span>
                  <StateBadge label={t(`status.${a.status}`)} tone={statusTone(a.status)} />
                </span>
                <span className="text-sm text-muted-foreground">
                  <CadenceText cadence={a.cadence} /> · {t(`duration.${a.duration}`)} ·{' '}
                  {t(`approval.${a.approvalMode}`)}
                </span>
                {a.periodIndex > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {t('detail.period', { n: a.periodIndex })}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
