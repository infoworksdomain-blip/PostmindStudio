import type { Page, Route } from '@playwright/test';
import type {
  BillingResponse,
  ChannelInterval,
  PlanChangeOutcome,
  PlanChangePreviewView,
  PlanPreviewResponse,
  PlansResponse,
  PlanView,
  PricingView,
} from '@/components/studio/billing/types';

// 21.5 (per-channel plan) — Stripe is never called by the QA specs. These helpers answer the
// "Your plan" endpoints in the browser with the JSON shapes the app reads
// (src/lib/studio/billing/pricing.ts, overview.ts, plan-change.ts):
//   GET    /api/studio/billing                  the real overview, with the plan state laid over it
//   GET    /api/studio/billing/plans            a PricingView with test amounts
//   GET    /api/studio/billing/invoices         no invoices
//   GET    /api/studio/billing/plan/preview     now (more channels / longer period) or period end
//   POST   /api/studio/billing/plan             applied now, or scheduled for the period end
//   POST   /api/studio/billing/plan/cancel      cancel at the period end
//   POST   /api/studio/billing/plan/resume      keep the plan
//   DELETE /api/studio/billing/plan/scheduled   drop the scheduled change
//   POST   /api/studio/billing/checkout         a return URL (no Stripe page)
//   POST   /api/studio/billing/portal           a return URL (no Stripe page)
// Every request the page sends is recorded so a spec can assert on what was asked.

/** Per-channel test prices in pence (a month is £29, so 3 channels are £87.00 a month). */
export const CHANNEL_PRICE_PENCE: Readonly<Record<ChannelInterval, number>> = {
  week: 900,
  month: 2_900,
  year: 29_000,
};

/** HD video packs: 5 for £15, 15 for £39. */
export const PACK_PRICE_PENCE = { studio_pack_hd5: 1_500, studio_pack_hd15: 3_900 } as const;

const VIDEOS_PER_CHANNEL: Readonly<Record<ChannelInterval, number>> = {
  week: 2,
  month: 8,
  year: 96,
};
const INTERVAL_RANK: Readonly<Record<ChannelInterval, number>> = { week: 0, month: 1, year: 2 };
const LOOKUP_KEY: Readonly<Record<ChannelInterval, string>> = {
  week: 'studio_channel_weekly',
  month: 'studio_channel_monthly',
  year: 'studio_channel_yearly',
};
const DAY_MS = 86_400_000;

/** "£87.00", as the app formats pence for en-GB. */
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

/** The PricingView /pricing, Your plan and sign-up read, with test amounts. */
export function pricingView(trialDays = 14): PricingView {
  return {
    catalogueVersion: 'qa',
    currency: 'gbp',
    available: true,
    channels: { min: 1, max: 6 },
    intervals: (['week', 'month', 'year'] as const).map((interval) => ({
      interval,
      lookupKey: LOOKUP_KEY[interval],
      unitAmountPence: CHANNEL_PRICE_PENCE[interval],
      videosPerChannel: VIDEOS_PER_CHANNEL[interval],
    })),
    yearlySavingPerChannelPence: CHANNEL_PRICE_PENCE.month * 12 - CHANNEL_PRICE_PENCE.year,
    topUps: (['studio_pack_hd5', 'studio_pack_hd15'] as const).map((lookupKey) => ({
      lookupKey,
      kind: 'short' as const,
      quantity: lookupKey === 'studio_pack_hd5' ? 5 : 15,
      validMonths: 3,
      unitAmountPence: PACK_PRICE_PENCE[lookupKey],
    })),
    trial: { days: trialDays, videos: 5 },
    fetchedAt: new Date().toISOString(),
  };
}

export interface ChannelChoice {
  channels: number;
  interval: ChannelInterval;
}

export interface PlanState extends ChannelChoice {
  cancelling: boolean;
  pending: { channels: number; interval: ChannelInterval; effectiveAt: string } | null;
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

const total = (choice: ChannelChoice): number =>
  CHANNEL_PRICE_PENCE[choice.interval] * choice.channels;

/** Upgrades (more channels, a longer period) apply now; anything else waits for the period end. */
export function timingOf(current: ChannelChoice, next: ChannelChoice): 'now' | 'period_end' {
  const fewer = next.channels < current.channels;
  const shorter = INTERVAL_RANK[next.interval] < INTERVAL_RANK[current.interval];
  return fewer || shorter ? 'period_end' : 'now';
}

/** What the preview says is due today for an immediate change (half the difference: a test value). */
export const dueNowPence = (current: ChannelChoice, next: ChannelChoice): number =>
  Math.max(0, Math.round((total(next) - total(current)) / 2));

export const PRORATION_DATE = 1_900_000_000;

/**
 * The Your-plan endpoints, answered in the browser. `plan: null` leaves the organisation without
 * a plan (Choose your plan + Checkout); otherwise a live Stripe subscription with that plan.
 */
export class BillingMock {
  readonly requests: RecordedRequest[] = [];
  readonly periodEnd = middayIn(20);
  private readonly origin: string;
  private state: PlanState | null;

  /** `origin`: where checkout and the portal "return" to (the app's base URL). */
  constructor(plan: ChannelChoice | null, origin: string) {
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
            lookupKey: LOOKUP_KEY[s.interval],
            interval: s.interval,
            quantity: s.channels,
            currentPeriodEnd: this.periodEnd,
            cancelAtPeriodEnd: s.cancelling,
            trialEnd: null,
          },
          plan: this.planView(s),
          channels: {
            paid: s.channels,
            connected: ['tiktok'],
            allowed: ['tiktok'],
            blocked: [],
          },
        }
      : { ...real.billing, checkoutEnabled: true };
    await route.fulfill({ response: res, json: { billing } satisfies BillingResponse });
  }

  private planView(s: PlanState): PlanView {
    return {
      channels: s.channels,
      interval: s.interval,
      source: 'stripe',
      legacy: false,
      pricePerPeriodPence: total(s),
      currency: 'gbp',
      pending: s.pending,
      paymentPending: false,
    };
  }

  private choiceOf(input: Record<string, unknown>): ChannelChoice {
    const interval = input.interval;
    return {
      channels: Number(input.channels),
      interval: interval === 'week' || interval === 'year' ? interval : 'month',
    };
  }

  private previewFor(next: ChannelChoice): PlanChangePreviewView | null {
    const s = this.state;
    if (!s) return null;
    const current = { channels: s.channels, interval: s.interval };
    const timing = timingOf(current, next);
    return {
      timing,
      current,
      next,
      nextPricePence: total(next),
      currency: 'gbp',
      effectiveAt: timing === 'now' ? null : this.periodEnd,
      dueNowPence: timing === 'now' ? dueNowPence(current, next) : null,
      prorationDate: timing === 'now' ? PRORATION_DATE : null,
    };
  }

  private async preview(route: Route, req: RecordedRequest): Promise<void> {
    const preview = this.previewFor(this.choiceOf(req.query));
    if (!preview)
      return json(route, { ok: false, error: 'plan_required', message: 'No plan' }, 402);
    return json(route, { preview } satisfies PlanPreviewResponse);
  }

  private async change(route: Route, req: RecordedRequest): Promise<void> {
    const next = this.choiceOf((req.body ?? {}) as Record<string, unknown>);
    const preview = this.previewFor(next);
    if (!preview || !this.state)
      return json(route, { ok: false, error: 'plan_required', message: 'No plan' }, 402);
    let outcome: PlanChangeOutcome;
    if (preview.timing === 'now') {
      this.state = { ...this.state, ...next, pending: null };
      outcome = { status: 'applied', timing: 'now' };
    } else {
      this.state = { ...this.state, pending: { ...next, effectiveAt: this.periodEnd } };
      outcome = { status: 'scheduled', timing: 'period_end', effectiveAt: this.periodEnd };
    }
    return json(route, { outcome });
  }
}
