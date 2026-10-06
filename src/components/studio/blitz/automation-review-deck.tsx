'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft, CalendarCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { ErrorState, PageHeader } from '../primitives';
import type { AutomationDetail, AutomationSlot } from '../automations/automation-model';
import { SwipeDeck } from './swipe-deck';
import type { FormatKey } from './blitz-model';

// 22.5 — "Review in Blitz first": the drafted period of an automation, one slot at a time. Keep
// leaves it in, skip takes it out, ↑ asks for a new topic. Nothing is made or charged until the
// period is approved ("Approve and schedule").

export function AutomationReviewDeck({ automationId }: { automationId: string }) {
  const t = useTranslations('automations');
  const tb = useTranslations('blitz.deck');
  const f = useFormat();
  const errorText = useErrorMessage();
  const { data, error, mutate } = useApi<AutomationDetail>(`/automations/${automationId}`);
  const [busy, setBusy] = useState(false);
  const period = data?.periods[0];
  const slots = useMemo(
    () => (period?.items ?? []).filter((i) => i.status === 'PLANNED' && !i.reviewed && i.title),
    [period],
  );
  const items = slots.map((slot) => ({
    ...slot,
    label: tb('cardLabel', {
      format: tb(`format.${(slot.format ?? 'carousel') as FormatKey}`),
      title: slot.title,
    }),
  }));

  const act = async (slot: AutomationSlot, action: 'keep' | 'skip' | 'reroll') => {
    setBusy(true);
    try {
      const next = await api<AutomationDetail>(`/automations/${automationId}/slots/${slot.id}`, {
        method: 'POST',
        body: { action },
        idempotencyKey: newIdempotencyKey(),
      });
      await mutate(next, { revalidate: false });
      if (action === 'reroll') toast(t('detail.rerolled'));
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    setBusy(true);
    try {
      await api(`/automations/${automationId}/approve`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(t('detail.approved'));
      void mutate();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const back = (
    <Button asChild variant="outline">
      <Link href={`/automations/${automationId}`}>
        <ArrowLeft className="rtl:rotate-180" /> {t('review.back')}
      </Link>
    </Button>
  );
  return (
    <>
      <PageHeader
        title={data ? t('review.title', { name: data.automation.name }) : t('review.loading')}
        description={t('review.description')}
        actions={back}
      />
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {!data && !error && (
        <div className="flex justify-center">
          <Skeleton className="aspect-[9/16] w-full max-w-[22rem] rounded-[1.75rem]" />
        </div>
      )}
      {data && data.automation.status !== 'REVIEW' && (
        <p className="text-center text-sm text-muted-foreground">{t('review.notInReview')}</p>
      )}
      {data && data.automation.status === 'REVIEW' && (
        <div className="flex flex-col items-center gap-4">
          {items.length > 0 ? (
            <SwipeDeck
              items={items}
              busy={busy}
              editLabel={t('detail.reroll')}
              onKeep={(slot) => void act(slot, 'keep')}
              onSkip={(slot) => void act(slot, 'skip')}
              onEdit={(slot) => void act(slot, 'reroll')}
              renderCard={(slot) => (
                <div className="flex size-full flex-col justify-between bg-gradient-to-b from-primary/10 via-card to-card p-6">
                  <div className="space-y-3">
                    <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
                      {f.date(slot.slotAt, {
                        weekday: 'long',
                        day: 'numeric',
                        month: 'long',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </p>
                    <span className="inline-flex rounded-full bg-primary/12 px-2 py-0.5 text-[11px] font-semibold text-primary">
                      {tb(`format.${(slot.format ?? 'carousel') as FormatKey}`)}
                    </span>
                    <h2 className="font-display text-3xl leading-tight">{slot.title}</h2>
                    {slot.slides?.hook && (
                      <p className="text-lg font-semibold leading-snug">{slot.slides.hook}</p>
                    )}
                  </div>
                  <ol className="list-decimal space-y-1.5 ps-5 text-sm text-muted-foreground">
                    {(slot.slides?.points ?? []).map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ol>
                </div>
              )}
            />
          ) : (
            <div className="flex max-w-sm flex-col items-center gap-4 rounded-[1.75rem] border border-dashed border-border px-6 py-12 text-center">
              <CalendarCheck className="size-8 text-primary" aria-hidden />
              <h2 className="font-display text-3xl">{t('review.done')}</h2>
              <p className="text-sm text-muted-foreground">{t('review.doneBody')}</p>
              <Button disabled={busy} onClick={() => void approve()}>
                {t('detail.approve')}
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
