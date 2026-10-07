'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { Section } from '../primitives';
import { ChannelPicker, type ChannelChoice } from './channel-picker';
import type { PlanPreviewResponse, PlanView, PricingView } from './types';

// Phase 21.5 "Your plan" — change channels and / or how often you pay, with a plain preview of
// the new price and when it applies before anything is charged:
//   - more channels or a longer period: now; the prorated amount due today comes from Stripe
//     (GET /billing/plan/preview → invoices.createPreview), and that same proration time is sent
//     with the change so the charge matches what was shown;
//   - fewer channels or a shorter period: at the end of the current period, nothing to pay now.
// Cancel (at the end of the period) and resume live here too.

const PREVIEW_DELAY_MS = 300;

function usePreview(choice: ChannelChoice, current: ChannelChoice, enabled: boolean) {
  const changed = choice.channels !== current.channels || choice.interval !== current.interval;
  const [debounced, setDebounced] = useState(choice);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(choice), PREVIEW_DELAY_MS);
    return () => clearTimeout(id);
  }, [choice]);
  const ready =
    enabled &&
    changed &&
    debounced.channels === choice.channels &&
    debounced.interval === choice.interval;
  return useApi<PlanPreviewResponse>(
    ready ? '/billing/plan/preview' : null,
    { channels: debounced.channels, interval: debounced.interval },
    { shouldRetryOnError: false },
  );
}

export function ChangePlanSection({
  plan,
  pricing,
  pending,
  disabledReason,
  onChange,
}: {
  plan: PlanView;
  pricing: PricingView;
  pending: string | null;
  /** Why changes are not possible right now (cancelling, payment problem), or null. */
  disabledReason: string | null;
  onChange: (next: ChannelChoice, prorationDate: number | null) => Promise<boolean>;
}) {
  const t = useTranslations('billing.yourPlan.change');
  const tPlan = useTranslations('channelPlan');
  const f = useFormat();
  const current: ChannelChoice = { channels: plan.channels, interval: plan.interval };
  const [choice, setChoice] = useState<ChannelChoice>(current);
  const [confirming, setConfirming] = useState(false);
  const preview = usePreview(choice, current, disabledReason === null);
  const p = preview.data?.preview;
  const changed = choice.channels !== current.channels || choice.interval !== current.interval;
  const effective = p?.effectiveAt ? f.date(p.effectiveAt, { dateStyle: 'long' }) : null;
  const newPrice = p
    ? tPlan(`total.${p.next.interval}`, { amount: f.pence(p.nextPricePence) })
    : '';
  const summary = p
    ? p.timing === 'now'
      ? t('appliesNow', {
          price: newPrice,
          due: f.pence(p.dueNowPence ?? 0),
        })
      : t('appliesLater', { price: newPrice, date: effective ?? '' })
    : null;

  return (
    <section id="change" className="scroll-mt-20">
      <Section title={t('title')} description={t('description')}>
        <div className="grid gap-5">
          {disabledReason && <p className="rounded-md bg-muted p-3 text-sm">{disabledReason}</p>}
          <ChannelPicker
            id="change-plan"
            value={choice}
            onChange={setChoice}
            pricing={pricing}
            disabled={disabledReason !== null || pending !== null}
          />
          {changed && disabledReason === null && (
            <div role="status" className="rounded-xl border border-border bg-muted/40 p-4 text-sm">
              {preview.isLoading || !p ? (
                preview.error ? (
                  <p>{t('previewFailed')}</p>
                ) : (
                  <p className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" aria-hidden /> {t('previewing')}
                  </p>
                )
              ) : (
                <div className="grid gap-1">
                  <p className="font-medium">{summary}</p>
                  <p className="text-muted-foreground">
                    {p.timing === 'now' ? t('nowRule') : t('laterRule')}
                  </p>
                </div>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!changed || !p || disabledReason !== null || pending !== null}
              onClick={() => setConfirming(true)}
            >
              {t('review')}
            </Button>
            {changed && (
              <Button
                variant="ghost"
                disabled={pending !== null}
                onClick={() => setChoice(current)}
              >
                {t('reset')}
              </Button>
            )}
          </div>
        </div>
      </Section>
      {confirming && p && (
        <Dialog open onOpenChange={(open) => !open && setConfirming(false)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t('confirmTitle')}</DialogTitle>
              <DialogDescription asChild>
                <div className="grid gap-2">
                  <p>
                    {t('confirmFrom', {
                      channels: p.current.channels,
                      period: p.current.interval,
                    })}
                  </p>
                  <p>{t('confirmTo', { channels: p.next.channels, period: p.next.interval })}</p>
                  <p className="font-medium">{summary}</p>
                </div>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                {t('cancel')}
              </Button>
              <Button
                disabled={pending !== null}
                onClick={async () => {
                  const ok = await onChange(p.next, p.prorationDate);
                  setConfirming(false);
                  if (ok) setChoice(p.next);
                }}
                loading={pending === 'change'}
              >
                {p.timing === 'now' && (p.dueNowPence ?? 0) > 0
                  ? t('confirmPay', { amount: f.pence(p.dueNowPence ?? 0) })
                  : t('confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}

export function CancelSection({
  cancelling,
  endsAt,
  pending,
  onCancel,
  onResume,
}: {
  cancelling: boolean;
  endsAt: string | null;
  pending: string | null;
  onCancel: () => Promise<boolean>;
  onResume: () => Promise<boolean>;
}) {
  const t = useTranslations('billing.yourPlan.cancel');
  const f = useFormat();
  const [confirming, setConfirming] = useState(false);
  const date = endsAt ? f.date(endsAt, { dateStyle: 'long' }) : null;
  return (
    <Section title={t('title')}>
      <div className="grid gap-3 text-sm">
        {cancelling ? (
          <>
            <p>{date ? t('endsOn', { date }) : t('ends')}</p>
            <div>
              <Button
                disabled={pending !== null}
                onClick={() => void onResume()}
                loading={pending === 'resume'}
              >
                {t('resume')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-muted-foreground">{t('body')}</p>
            <div>
              <Button
                variant="outline"
                disabled={pending !== null}
                onClick={() => setConfirming(true)}
              >
                {t('cancel')}
              </Button>
            </div>
          </>
        )}
      </div>
      {confirming && (
        <Dialog open onOpenChange={(open) => !open && setConfirming(false)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t('confirmTitle')}</DialogTitle>
              <DialogDescription>
                {date ? t('confirmBodyDate', { date }) : t('confirmBody')}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                {t('keep')}
              </Button>
              <Button
                variant="destructive"
                disabled={pending !== null}
                onClick={async () => {
                  await onCancel();
                  setConfirming(false);
                }}
                loading={pending === 'cancel'}
              >
                {t('confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Section>
  );
}
