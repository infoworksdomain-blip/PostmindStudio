import type { BillingInterval } from './catalogue';
import type { PlanTier } from '../providers/router';

// Phase 18 §2.7 — the billing service Track C builds and Track E's screens call. Route handlers
// under /api/studio/billing/* delegate to it; nothing outside Track C talks to Stripe.

export interface CheckoutRequest {
  organisationId: string;
  userId: string;
  /** Subscription (tier + interval) or one-time top-up pack. */
  intent:
    | { kind: 'subscription'; tier: Exclude<PlanTier, 'ENTERPRISE'>; interval: BillingInterval }
    | { kind: 'topup'; lookupKey: string };
  locale: string;
}

export interface BillingInvoice {
  id: string;
  number: string | null;
  status: string;
  amountDuePence: number;
  currency: string;
  createdAt: string;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
}

export interface BillingService {
  /** A Stripe Checkout session URL on APP_URL success / cancel pages. */
  createCheckout(request: CheckoutRequest): Promise<{ url: string }>;
  /** A Stripe Customer Portal session URL. */
  createPortal(organisationId: string, returnPath: string): Promise<{ url: string }>;
  listInvoices(organisationId: string, limit: number): Promise<BillingInvoice[]>;
  /** Cancel immediately (account / organisation deletion, §5.11). No-op without a subscription. */
  cancelForDeletion(organisationId: string): Promise<void>;
}
