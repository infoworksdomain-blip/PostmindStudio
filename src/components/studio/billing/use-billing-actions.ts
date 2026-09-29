'use client';

import { useCallback, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { api, ApiError, newIdempotencyKey, useErrorMessage } from '@/lib/client/api';
import { navigateTo } from './navigate';
import type { BillingInterval, SelfServeTier } from './types';

// Phase 18 §2.7 — the two ways the browser leaves for Stripe: Checkout (a new subscription or a
// one-off top-up) and the Customer Portal (payment method, plan change, cancel). Both answer
// { url } and the page navigates there. Owner only (studio:billing:manage); the screens hide the
// buttons for everyone else.

export type CheckoutIntent =
  | { kind: 'subscription'; tier: SelfServeTier; interval: BillingInterval }
  | { kind: 'topup'; lookupKey: string };

export function useBillingActions(options: { onConflict?: () => void } = {}) {
  const t = useTranslations('billing.plan');
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const [pending, setPending] = useState<string | null>(null);
  const { onConflict } = options;

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

  return { pending, checkout, portal };
}
