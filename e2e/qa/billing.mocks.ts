import type { Page, Route } from '@playwright/test';
import type {
  BillingResponse,
  PlanChangeOutcome,
  PlanChangePreviewView,
  PlanChoice,
  PlanId,
  PlanInterval,
  PlanPreviewResponse,
  PlansResponse,
  PlanView,
  PricingView,
} from '@/components/studio/billing/types';
import {
  isPlanId,
  isPlanInterval,
  MOST_POPULAR_PLAN,
  PLAN_IDS,
  PLAN_INTERVALS,
  planChangeTiming,
  planLookupKey,
  planPricePence,
  STUDIO_PLANS,
} from '@/lib/studio/billing/plans';

// 26.1 (Starter / Growth / Pro) — Stripe is never called by the QA specs. These helpers answer
// the "Your plan" endpoints in the browser with the JSON shapes the app reads
// (src/lib/studio/billing/pricing.ts, overview.ts, plan-change.ts):
//   GET    /api/studio/billing                  the real overview, with the plan state laid over it
//   GET    /api/studio/billing/plans            a PricingView with the reference amounts
//   GET    /api/studio/billing/invoices         no invoices
//   GET    /api/studio/billing/plan/preview     now (a higher plan / longer period) or period end
//   POST   /api/studio/billing/plan             applied now, or scheduled for the period end
//   POST   /api/studio/billing/plan/cancel      cancel at the period end
//   POST   /api/studio/billing/plan/resume      keep the plan
//   DELETE /api/studio/billing/plan/scheduled   drop the scheduled change
//   POST   /api/studio/billing/checkout         a return URL (no Stripe page)
//   POST   /api/studio/billing/portal           a return URL (no Stripe page)
// Every request the page sends is recorded so a spec can assert on what was asked.

/** A plan's price per period in pence (the reference amounts: Growth monthly is £69.00). */
export const planPrice = (choice: PlanChoice): number =>
  planPricePence(choice.plan, choice.interval);

/** HD video packs: 5 for £17, 15 for £45. */
export const PACK_PRICE_PENCE = { studio_pack_hd5: 1_700, studio_pack_hd15: 4_500 } as const;

const DAY_MS = 86_400_000;

/** "£69.00", as the app formats pence for en-GB. */
export const gbp = (pence: number): string =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(pence / 100);

/** "4 November 2026", as the app formats dates with dateStyle long for en-GB. */
export const longDate = (iso: string): string =>
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(iso));

/** Midday UTC `days` from now, so the long date reads the same in any time zone the app uses. */
export function middayIn(days: number): string {
  const d = new Date(Date.now() + days * DAY_MS);
  d.setUTCHours(12, 0, 0, 0);
  return d.toISOString();
}

/** The PricingView /pricing, Your plan and sign-up read, with the reference amounts. */
export function pricingView(trialDays = 7): PricingView {
  return {
    catalogueVersion: 'qa',
    currency: 'gbp',
    available: true,
    plans: PLAN_IDS.map((plan) => {
      const def = STUDIO_PLANS[plan];
      const prices = Object.fromEntries(
        PLAN_INTERVALS.map((interval) => [
          interval,
          {
            lookupKey: planLookupKey(plan, interval),
            unitAmountPence: planPricePence(plan, interval),
          },
        ]),
      ) as PricingView['plans'][number]['prices'];
      return {
        plan,
        mostPopular: plan === MOST_POPULAR_PLAN,
        videosPerMonth: def.videosPerMonth,
        videosPerWeek: def.videosPerWeek,
        businesses: def.businesses,
        seats: def.seats,
        prices,
        yearlySavingPence: planPricePence(plan, 'month') * 12 - planPricePence(plan, 'year'),
      };
    }),
    topUps: (['studio_pack_hd5', 'studio_pack_hd15'] as const).map((lookupKey) => ({
      lookupKey,
      kind: 'short' as const,
      quantity: lookupKey === 'studio_pack_hd5' ? 5 : 15,
      validMonths: 3,
      unitAmountPence: PACK_PRICE_PENCE[lookupKey],
    })),
    trial: { days: trialDays, videos: 2 },
    fetchedAt: new Date().toISOString(),
  };
}

export interface PlanState extends PlanChoice {
  cancelling: boolean;
  pending: { plan: PlanId; interval: PlanInterval; effectiveAt: string } | null;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

const json = (route: Route, body: unknown, status = 200): Promise<void> =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

function bodyOf(route: Route): unknown {
  const raw = route.request().postData();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** A higher plan, or a longer period on the same plan, applies now; anything else at period end. */
export function timingOf(current: PlanChoice, next: PlanChoice): 'now' | 'period_end' {
  return planChangeTiming(current, next) === 'now' ? 'now' : 'period_end';
}

/** What the preview says is due today for an immediate change (half the difference: a test value). */
export const dueNowPence = (current: PlanChoice, next: PlanChoice): number =>
  Math.max(0, Math.round((planPrice(next) - planPrice(current)) / 2));

export const PRORATION_DATE = 1_900_000_000;

/**
 * The Your-plan endpoints, answered in the browser. `plan: null` leaves the organisation without
 * a plan (Choose your plan + Checkout); otherwise a live Stripe subscription on that plan.
 */
export class BillingMock {
  readonly requests: RecordedRequest[] = [];
  readonly periodEnd = middayIn(20);
  private readonly origin: string;
  private state: PlanState | null;

  /** `origin`: where checkout and the portal "return" to (the app's base URL). */
  constructor(plan: PlanChoice | null, origin: string) {
    this.origin = origin;
    this.state = plan && { ...plan, cancelling: false, pending: null };
  }

  get plan(): PlanState | null {
    return this.state;
  }

  /** Requests the page sent to one endpoint (method + path relative to /api/studio). */
  sent(method: string, path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && r.path === `/api/studio${path}`);
  }

  /** Replaces every route already on the page (earlier tests' mocks) with these. */
  async install(page: Page): Promise<void> {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.route(
      (url) => url.pathname.startsWith('/api/studio/billing'),
      (route) => this.handle(route),
    );
  }

  private record(route: Route): RecordedRequest {
    const url = new URL(route.request().url());
    const entry: RecordedRequest = {
      method: route.request().method(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: bodyOf(route),
    };
    this.requests.push(entry);
    return entry;
  }

  private async handle(route: Route): Promise<void> {
    const req = this.record(route);
    const key = `${req.method} ${req.path.replace('/api/studio/billing', '') || '/'}`;
    switch (key) {
      case 'GET /':
        return this.overview(route);
      case 'GET /plans':
        return json(route, { pricing: pricingView() } satisfies PlansResponse);
      case 'GET /invoices':
        return json(route, { invoices: [] });
      case 'GET /plan/preview':
        return this.preview(route, req);
      case 'POST /plan':
        return this.change(route, req);
      case 'POST /plan/cancel':
        this.state = this.state && { ...this.state, cancelling: true };
        return json(route, { endsAt: this.periodEnd });
      case 'POST /plan/resume':
        this.state = this.state && { ...this.state, cancelling: false };
        return json(route, { resumed: true });
      case 'DELETE /plan/scheduled':
        this.state = this.state && { ...this.state, pending: null };
        return json(route, { cancelled: true });
      case 'POST /checkout': {
        const kind = (req.body as { kind?: string } | undefined)?.kind;
        const back = kind === 'topup' ? 'topup=success' : 'checkout=success';
        return json(route, { url: `${this.origin}/settings/billing?${back}` });
      }
      case 'POST /portal':
        return json(route, { url: `${this.origin}/settings/billing?portal=returned` });
      default:
        return route.continue();
    }
  }

  /** The real overview (usage, seats, credits, canManage) with the plan laid over it. */
  private async overview(route: Route): Promise<void> {
    const res = await route.fetch();
    const real = (await res.json()) as BillingResponse;
    const s = this.state;
    const billing: BillingResponse['billing'] = s
      ? {
          ...real.billing,
          checkoutEnabled: true,
          hasBillingAccount: true,
          entitlements: {
            ...real.billing.entitlements,
            access: 'full',
            source: 'stripe',
            graceUntil: null,
            trial: null,
            subscriptionStatus: 'active',
          },
          subscription: {
            status: 'active',
            lookupKey: planLookupKey(s.plan, s.interval),
            interval: s.interval,
            quantity: 1,
            currentPeriodEnd: this.periodEnd,
            cancelAtPeriodEnd: s.cancelling,
            trialEnd: null,
          },
          plan: this.planView(s),
        }
      : { ...real.billing, checkoutEnabled: true };
    await route.fulfill({ response: res, json: { billing } satisfies BillingResponse });
  }

  private planView(s: PlanState): PlanView {
    return {
      id: s.plan,
      interval: s.interval,
      source: 'stripe',
      legacy: false,
      pricePerPeriodPence: planPrice(s),
      currency: 'gbp',
      pending: s.pending,
      paymentPending: false,
    };
  }

  /** The { plan, interval } the page sent; anything else is a bad request (as the API says). */
  private choiceOf(input: Record<string, unknown>): PlanChoice | null {
    const { plan, interval } = input;
    return isPlanId(plan) && isPlanInterval(interval) ? { plan, interval } : null;
  }

  private previewFor(next: PlanChoice): PlanChangePreviewView | null {
    const s = this.state;
    if (!s) return null;
    const current = { plan: s.plan, interval: s.interval };
    const timing = timingOf(current, next);
    return {
      timing,
      current,
      next,
      nextPricePence: planPrice(next),
      currency: 'gbp',
      effectiveAt: timing === 'now' ? null : this.periodEnd,
      dueNowPence: timing === 'now' ? dueNowPence(current, next) : null,
      prorationDate: timing === 'now' ? PRORATION_DATE : null,
    };
  }

  private async preview(route: Route, req: RecordedRequest): Promise<void> {
    const next = this.choiceOf(req.query);
    if (!next)
      return json(route, { ok: false, error: 'validation_error', message: 'Bad plan' }, 400);
    const preview = this.previewFor(next);
    if (!preview)
      return json(route, { ok: false, error: 'plan_required', message: 'No plan' }, 402);
    return json(route, { preview } satisfies PlanPreviewResponse);
  }

  private async change(route: Route, req: RecordedRequest): Promise<void> {
    const next = this.choiceOf((req.body ?? {}) as Record<string, unknown>);
    if (!next)
      return json(route, { ok: false, error: 'validation_error', message: 'Bad plan' }, 400);
    const preview = this.previewFor(next);
    if (!preview || !this.state)
      return json(route, { ok: false, error: 'plan_required', message: 'No plan' }, 402);
    let outcome: PlanChangeOutcome;
    if (preview.timing === 'now') {
      this.state = { ...this.state, plan: next.plan, interval: next.interval, pending: null };
      outcome = { status: 'applied', timing: 'now' };
    } else {
      this.state = { ...this.state, pending: { ...next, effectiveAt: this.periodEnd } };
      outcome = { status: 'scheduled', timing: 'period_end', effectiveAt: this.periodEnd };
    }
    return json(route, { outcome });
  }
}
