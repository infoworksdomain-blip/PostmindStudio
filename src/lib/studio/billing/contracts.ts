import type { ChannelInterval, ChannelPlanChoice } from './channel-plan';
import type { PlanChangeOutcome, PlanChangePreviewView } from './plan-change';

// Phase 18 §2.7 — the billing service Track C builds and Track E's screens call. Route handlers
// under /api/studio/billing/* delegate to it; nothing outside Track C talks to Stripe.

export interface CheckoutRequest {
  organisationId: string;
  userId: string;
  /** 21.5: a per-channel subscription (1–6 channels + interval) or a one-off HD video pack. */
  intent:
    | { kind: 'channels'; channels: number; interval: ChannelInterval }
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
  /** 21.5 Your plan: what a channel / interval change costs and when it applies. */
  previewPlanChange(
    organisationId: string,
    next: ChannelPlanChoice,
  ): Promise<PlanChangePreviewView>;
  /** 21.5: apply it (upgrade now with proration, downgrade at the end of the period). */
  changePlan(input: {
    organisationId: string;
    userId: string;
    next: ChannelPlanChoice;
    prorationDate?: number | null;
  }): Promise<PlanChangeOutcome>;
  /** 21.5: cancel at the end of the period. */
  cancelPlan(input: { organisationId: string; userId: string }): Promise<{ endsAt: string | null }>;
  /** 21.5: undo a cancellation before the period ends. */
  resumePlan(input: { organisationId: string; userId: string }): Promise<void>;
  /** 21.5: drop the change scheduled for the end of the period. */
  cancelScheduledChange(input: { organisationId: string; userId: string }): Promise<void>;
}
