'use client';

import { useCallback, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { api, ApiError, newIdempotencyKey, useErrorMessage } from '@/lib/client/api';
import { navigateTo } from './navigate';
import type { PlanChangeOutcome, PlanChoice } from './types';

// Phase 18 §2.7 / 21.5 — what the billing screens ask the server to do:
//   - Checkout (leaves for Stripe): a new plan subscription or a one-off video pack;
//   - the Customer Portal (leaves for Stripe): payment method and invoices only;
//   - Your plan (stays in Studio): change the plan / interval, cancel, resume, keep the current
//     plan instead of a scheduled change. Each sends an Idempotency-Key, so a double click is one
//     change.
// Owner only (studio:billing:manage); the screens hide the buttons for everyone else.

export type CheckoutIntent = ({ kind: 'plan' } & PlanChoice) | { kind: 'topup'; lookupKey: string };

export function useBillingActions(
  options: { onConflict?: () => void; onChanged?: () => void } = {},
) {
  const t = useTranslations('billing.plan');
  const tPlan = useTranslations('billing.yourPlan.toasts');
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const [pending, setPending] = useState<string | null>(null);
  const { onConflict, onChanged } = options;

  const checkout = useCallback(
    async (intent: CheckoutIntent, pendingKey: string) => {
      setPending(pendingKey);
      try {
        const res = await api<{ url: string }>('/billing/checkout', {
          method: 'POST',
          body: { ...intent, locale },
          idempotencyKey: newIdempotencyKey(),
        });
        navigateTo(res.url);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          toast.error(t('alreadySubscribed'));
          onConflict?.();
        } else toast.error(errorMessage(err));
        setPending(null);
      }
    },
    [locale, errorMessage, t, onConflict],
  );

  const portal = useCallback(async () => {
    setPending('portal');
    try {
      const res = await api<{ url: string }>('/billing/portal', {
        method: 'POST',
        body: { returnPath: '/settings/billing' },
      });
      navigateTo(res.url);
    } catch (err) {
      toast.error(errorMessage(err));
      setPending(null);
    }
  }, [errorMessage]);

  /** Runs one Your-plan request; true when it succeeded (the page then reloads its data). */
  const run = useCallback(
    async <T>(key: string, request: () => Promise<T>, done: (result: T) => void) => {
      setPending(key);
      try {
        const result = await request();
        done(result);
        onChanged?.();
        return true;
      } catch (err) {
        toast.error(errorMessage(err));
        onChanged?.();
        return false;
      } finally {
        setPending(null);
      }
    },
    [errorMessage, onChanged],
  );

  const changePlan = useCallback(
    (next: PlanChoice, prorationDate: number | null) =>
      run(
        'change',
        () =>
          api<{ outcome: PlanChangeOutcome }>('/billing/plan', {
            method: 'POST',
            body: { plan: next.plan, interval: next.interval, prorationDate },
            idempotencyKey: newIdempotencyKey(),
          }),
        ({ outcome }) => {
          if (outcome.status === 'payment_required') toast.error(tPlan('paymentRequired'));
          else if (outcome.status === 'scheduled') toast.success(tPlan('scheduled'));
          else toast.success(tPlan('applied'));
        },
      ),
    [run, tPlan],
  );

  const cancelPlan = useCallback(
    () =>
      run(
        'cancel',
        () =>
          api<{ endsAt: string | null }>('/billing/plan/cancel', {
            method: 'POST',
            idempotencyKey: newIdempotencyKey(),
          }),
        () => toast.success(tPlan('cancelled')),
      ),
    [run, tPlan],
  );

  const resumePlan = useCallback(
    () =>
      run(
        'resume',
        () =>
          api<{ resumed: boolean }>('/billing/plan/resume', {
            method: 'POST',
            idempotencyKey: newIdempotencyKey(),
          }),
        () => toast.success(tPlan('resumed')),
      ),
    [run, tPlan],
  );

  const keepCurrentPlan = useCallback(
    () =>
      run(
        'keep',
        () =>
          api<{ cancelled: boolean }>('/billing/plan/scheduled', {
            method: 'DELETE',
            idempotencyKey: newIdempotencyKey(),
          }),
        () => toast.success(tPlan('kept')),
      ),
    [run, tPlan],
  );

  return { pending, checkout, portal, changePlan, cancelPlan, resumePlan, keepCurrentPlan };
}
