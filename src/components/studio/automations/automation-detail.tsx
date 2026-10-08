'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft, Layers, Pause, Play, TrendingUp, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { StudioCapability } from '@/lib/rbac';
import { ErrorState, PageHeader, StateBadge } from '../primitives';
import { WriteGate } from '../write-gate';
import { useCan } from '../use-can';
import { CadenceText } from './automations-list';
import { PAUSE_REASONS, statusTone, type AutomationDetail } from './automation-model';
import { AutomationRuns } from './automation-runs';

// 22.5 — /automations/:id: status and actions (start, review in Blitz / approve, pause, resume,
// cancel), why it is paused (with the add-videos prompt when the allowance is used up), the
// weekly insight ("make more like this") and (25.9) the timeline of its runs (automation-runs.tsx).

export function AutomationDetailScreen({ automationId }: { automationId: string }) {
  const t = useTranslations('automations');
  const errorText = useErrorMessage();
  const mayPost = useCan(StudioCapability.PublicationWrite);
  const { data, error, mutate } = useApi<AutomationDetail>(
    `/automations/${automationId}`,
    undefined,
    {
      refreshInterval: (latest) =>
        latest && ['GENERATING', 'ACTIVE'].includes(latest.automation.status) ? 15_000 : 0,
    },
  );
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();

  const run = async (action: string, done?: string) => {
    if (
      action === 'cancel' &&
      !(await confirm({ title: t('detail.cancelConfirm'), confirmLabel: t('detail.cancel') }))
    )
      return;
    setBusy(true);
    try {
      await api(`/automations/${automationId}/${action}`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
      });
      if (done) toast.success(done);
      await mutate();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const slot = async (itemId: string, action: 'keep' | 'skip' | 'reroll') => {
    setBusy(true);
    try {
      const next = await api<AutomationDetail>(`/automations/${automationId}/slots/${itemId}`, {
        method: 'POST',
        body: { action },
        idempotencyKey: newIdempotencyKey(),
      });
      await mutate(next, { revalidate: false });
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const back = (
    <Button asChild variant="outline">
      <Link href="/automations">
        <ArrowLeft className="rtl:rotate-180" /> {t('detail.back')}
      </Link>
    </Button>
  );
  if (error)
    return (
      <>
        <PageHeader title={t('list.title')} actions={back} />
        <ErrorState error={error} onRetry={() => void mutate()} />
      </>
    );
  if (!data)
    return (
      <>
        <PageHeader title={t('list.title')} actions={back} />
        <Skeleton aria-label={t('list.loading')} className="h-64 rounded-xl" />
      </>
    );

  const a = data.automation;
  const reason =
    a.pauseReason && (PAUSE_REASONS as readonly string[]).includes(a.pauseReason)
      ? (a.pauseReason as (typeof PAUSE_REASONS)[number])
      : null;
  return (
    <>
      <PageHeader
        title={a.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StateBadge label={t(`status.${a.status}`)} tone={statusTone(a.status)} />
            <span>
              <CadenceText cadence={a.cadence} /> · {t(`duration.${a.duration}`)} ·{' '}
              {t(`approval.${a.approvalMode}`)}
            </span>
          </span>
        }
        actions={back}
      />
      {confirmDialog}
      <WriteGate>
        <div className="mb-6 flex flex-wrap gap-2">
          {a.status === 'DRAFT' && (
            <Button
              disabled={busy || !mayPost}
              onClick={() => void run('start', t('wizard.started'))}
            >
              <Play /> {t('detail.start')}
            </Button>
          )}
          {a.status === 'REVIEW' && (
            <>
              <Button asChild>
                <Link href={`/blitz?automation=${a.id}`}>
                  <Layers /> {t('detail.review')}
                </Link>
              </Button>
              <Button
                variant="outline"
                disabled={busy || !mayPost}
                onClick={() => void run('approve', t('detail.approved'))}
              >
                {t('detail.approve')}
              </Button>
            </>
          )}
          {['GENERATING', 'REVIEW', 'ACTIVE'].includes(a.status) && (
            <Button variant="outline" disabled={busy} onClick={() => void run('pause')}>
              <Pause /> {t('detail.pause')}
            </Button>
          )}
          {a.status === 'PAUSED' && (
            <Button disabled={busy || !mayPost} onClick={() => void run('resume')}>
              <Play /> {t('detail.resume')}
            </Button>
          )}
          {!['CANCELLED', 'COMPLETED'].includes(a.status) && (
            <Button
              variant="ghost"
              className="text-destructive"
              disabled={busy}
              onClick={() => void run('cancel')}
            >
              <XCircle /> {t('detail.cancel')}
            </Button>
          )}
        </div>
      </WriteGate>

      {a.status === 'PAUSED' && reason && (
        <div
          role="status"
          className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-panel bg-warning-soft p-4 text-sm"
        >
          <span>{t(`detail.pauseReason.${reason}`)}</span>
          {reason === 'allowance' && (
            <Button asChild size="sm" variant="outline">
              <Link href="/settings/billing">{t('detail.upgrade')}</Link>
            </Button>
          )}
        </div>
      )}

      {a.insight && (
        <section className="mb-8 flex flex-wrap items-center justify-between gap-4 rounded-panel border border-border bg-card p-5">
          <div className="flex items-start gap-3">
            <TrendingUp className="mt-0.5 size-5 text-primary" aria-hidden />
            <div>
              <p className="text-xs font-medium text-muted-foreground">
                {t('detail.insightTitle')}
              </p>
              <p className="font-medium">
                {t('detail.insightBody', { title: a.insight.title, views: a.insight.views })}
              </p>
            </div>
          </div>
          <WriteGate>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void run('more-like-this', t('detail.moreDone'))}
            >
              <TrendingUp /> {t('detail.moreLikeThis')}
            </Button>
          </WriteGate>
        </section>
      )}

      <AutomationRuns
        periods={data.periods}
        periodIndex={a.periodIndex}
        reviewing={a.status === 'REVIEW'}
        busy={busy}
        onSlot={slot}
      />
    </>
  );
}
