'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Download,
  Layers,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
  TrendingUp,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { StudioCapability } from '@/lib/rbac';
import { cn } from '@/lib/utils';
import type { FormatKey } from '../blitz/blitz-model';
import { ErrorState, PageHeader, StateBadge } from '../primitives';
import { ReasonText } from '../plans/plan-parts';
import { WriteGate } from '../write-gate';
import { useCan } from '../use-can';
import { CadenceText } from './automations-list';
import {
  PAUSE_REASONS,
  statusTone,
  type AutomationDetail,
  type AutomationPeriod,
  type AutomationSlot,
} from './automation-model';

// 22.5 — /automations/:id: status and actions (start, review in Blitz / approve, pause, resume,
// cancel), why it is paused (with the add-videos prompt when the allowance is used up), the
// weekly insight ("make more like this") and each period's slot calendar: format, angle, title,
// status and reason per slot, "download only" networks, and in review reroll / remove / keep.

const LIVE_ITEM = new Set([
  'QUEUED',
  'GENERATING',
  'READY',
  'SCHEDULED',
  'POSTED',
  'PLANNED',
  'HELD',
]);

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

  const run = async (action: string, done?: string) => {
    if (action === 'cancel' && !window.confirm(t('detail.cancelConfirm'))) return;
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
      ? a.pauseReason
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
          className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm"
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
        <section className="mb-8 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/8 to-transparent p-5">
          <div className="flex items-start gap-3">
            <TrendingUp className="mt-0.5 size-5 text-primary" aria-hidden />
            <div>
              <p className="text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">
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
              <Sparkles /> {t('detail.moreLikeThis')}
            </Button>
          </WriteGate>
        </section>
      )}

      {data.periods.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('detail.noPeriods')}</p>
      )}
      {data.periods.map((period, i) => (
        <PeriodCalendar
          key={period.id}
          period={period}
          n={a.periodIndex - i}
          reviewing={a.status === 'REVIEW' && i === 0}
          busy={busy}
          onSlot={slot}
        />
      ))}
    </>
  );
}

function PeriodCalendar({
  period,
  n,
  reviewing,
  busy,
  onSlot,
}: {
  period: AutomationPeriod;
  n: number;
  reviewing: boolean;
  busy: boolean;
  onSlot: (itemId: string, action: 'keep' | 'skip' | 'reroll') => void;
}) {
  const t = useTranslations('automations');
  const tb = useTranslations('blitz.deck');
  const tp = useTranslations('plans');
  const f = useFormat();
  const byDay = new Map<string, AutomationSlot[]>();
  for (const item of period.items) {
    const day = f.date(item.slotAt, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: period.timezone,
    });
    byDay.set(day, [...(byDay.get(day) ?? []), item]);
  }
  return (
    <section className="mb-10" aria-labelledby={`period-${period.id}`}>
      <h2 id={`period-${period.id}`} className="mb-3 flex flex-wrap items-baseline gap-3">
        <span className="font-display text-2xl">{t('detail.period', { n: Math.max(1, n) })}</span>
        <StateBadge label={tp(`status.${period.status as 'DRAFT'}`)} tone="neutral" />
        {period.holdReason === 'paused' && (
          <span className="text-xs text-muted-foreground">{tp('hold.paused')}</span>
        )}
      </h2>
      {period.status === 'DRAFTING' && (
        <p role="status" className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
          <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />{' '}
          {t('detail.writing')}
        </p>
      )}
      <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {[...byDay.entries()].map(([day, items]) => (
          <li key={day} className="rounded-2xl border border-border bg-card p-4">
            <p className="mb-2 text-xs font-semibold tracking-[0.12em] text-muted-foreground uppercase">
              {day}
            </p>
            <ul className="space-y-3">
              {items.map((item) => {
                const live = LIVE_ITEM.has(item.status);
                return (
                  <li key={item.id} className={cn('space-y-1', !live && 'opacity-60')}>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="tabular-nums text-muted-foreground">
                        {f.date(item.slotAt, {
                          hour: 'numeric',
                          minute: '2-digit',
                          timeZone: period.timezone,
                        })}
                      </span>
                      {item.format && (
                        <span className="rounded-full bg-primary/12 px-2 py-0.5 font-semibold text-primary">
                          {tb(`format.${item.format as FormatKey}`)}
                        </span>
                      )}
                      <span className="text-muted-foreground">
                        {tp(`itemStatus.${item.status as 'PLANNED'}`)}
                      </span>
                      {item.reviewed && (
                        <span className="text-success">{t('detail.reviewed')}</span>
                      )}
                    </div>
                    {item.projectId ? (
                      <Link
                        href={`/projects/${item.projectId}`}
                        className="block text-sm font-medium hover:underline"
                      >
                        {item.title || t('detail.untitled')}
                      </Link>
                    ) : (
                      <p className="text-sm font-medium">{item.title || t('detail.untitled')}</p>
                    )}
                    <ReasonText reason={item.statusReason} />
                    {item.downloadOnly.length > 0 && (
                      <p className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Download className="size-3" aria-hidden />
                        {t('detail.downloadOnly', {
                          platforms: f.list(item.downloadOnly.map((p) => f.platform(p))),
                        })}
                      </p>
                    )}
                    {reviewing && item.status === 'PLANNED' && (
                      <WriteGate>
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => onSlot(item.id, 'reroll')}
                          >
                            <RefreshCw /> {t('detail.reroll')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => onSlot(item.id, 'skip')}
                          >
                            <Trash2 /> {t('detail.remove')}
                          </Button>
                          {!item.reviewed && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => onSlot(item.id, 'keep')}
                            >
                              {t('detail.keep')}
                            </Button>
                          )}
                        </div>
                      </WriteGate>
                    )}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}
