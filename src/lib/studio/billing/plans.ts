import { ValidationError } from '../../errors';

// Phase 26.1 (operator decision 2026-10-09, "apply new pricing") — THREE plans, priced by HD
// videos. Every plan posts to every platform (TikTok, Instagram, YouTube, Facebook, LinkedIn, X):
//
//   plan     month   week (see the rounding)   year (10 × month)   HD videos a month / a week   businesses   seats
//   starter  £29     £9.50                     £290                8 / 2                        1            1
//   growth   £69     £22.50                    £690                20 / 5                       1            3
//   pro      £149    £48.50                    £1,490              45 / 11                      3            10
//
//   Weekly is deliberately dearer: monthly ÷ 4 × 1.3, ROUNDED UP to the next 50p. Yearly is paid
//   upfront: 10 × monthly ("2 months free"). The Stripe subscription has ONE item, quantity 1, on
//   the plan's price (lookup key studio_<plan>_<weekly|monthly|yearly>, product studio_plan_<plan>).
//
//   Allowance windows (unchanged from 21.5): monthly counts per calendar month (UTC); yearly is
//   released per calendar month (the monthly number each month); weekly counts per ISO week
//   (Monday 00:00 UTC). Cheap formats still use ¼ of a video and UGC 2 (allowance-units.ts).
//
//   Every plan is the internal tier STANDARD (routing, render quality, gates: the same HD video
//   on every plan); long videos are not part of any plan (allowance 0, hidden in the customer UI).
//
//   Back-compat (21.5 → 26.1): a subscription still on a per-channel price
//   (studio_channel_<interval>, quantity = channels) keeps working until
//   scripts/billing/migrate-to-tiers.ts moves it: 1 channel → starter, 2–3 → growth, 4+ → pro.
//
// Everything here is pure and unit tested (plans.test.ts). Amounts in Stripe are created from
// PLAN_PRICE_PENCE by scripts/billing/seed-stripe-test.ts; the app reads live amounts from Stripe
// by lookup key.

export const PLAN_VERSION = '2026-10-09';

export type PlanId = 'starter' | 'growth' | 'pro';
/** Cheapest first (the display order; Pro is shown last). */
export const PLAN_IDS: readonly PlanId[] = ['starter', 'growth', 'pro'];
/** Plan names are product names: never translated (Phase 16 rule). */
export const PLAN_NAMES: Readonly<Record<PlanId, string>> = Object.freeze({
  starter: 'Starter',
  growth: 'Growth',
  pro: 'Pro',
});
/** The plan shown as "Most popular". */
export const MOST_POPULAR_PLAN: PlanId = 'growth';

export type PlanInterval = 'week' | 'month' | 'year';
export const PLAN_INTERVALS: readonly PlanInterval[] = ['week', 'month', 'year'];

export interface PlanChoice {
  plan: PlanId;
  interval: PlanInterval;
}

/** The internal tier every plan maps to (routing, quality, cost guards). */
export const PLAN_TIER = 'STANDARD' as const;

export interface StudioPlanDefinition {
  id: PlanId;
  /** The reference rate, pence a month excl. VAT. */
  monthlyPence: number;
  /** HD videos a calendar month (monthly, and yearly per calendar month). */
  videosPerMonth: number;
  /** HD videos an ISO week (weekly). */
  videosPerWeek: number;
  businesses: number;
  seats: number;
}

export const STUDIO_PLANS: Readonly<Record<PlanId, StudioPlanDefinition>> = Object.freeze({
  starter: {
    id: 'starter',
    monthlyPence: 2_900,
    videosPerMonth: 8,
    videosPerWeek: 2,
    businesses: 1,
    seats: 1,
  },
  growth: {
    id: 'growth',
    monthlyPence: 6_900,
    videosPerMonth: 20,
    videosPerWeek: 5,
    businesses: 1,
    seats: 3,
  },
  pro: {
    id: 'pro',
    monthlyPence: 14_900,
    videosPerMonth: 45,
    videosPerWeek: 11,
    businesses: 3,
    seats: 10,
  },
});

/** Weekly = monthly ÷ 4 × 1.3, rounded UP to the next 50p. */
export const WEEKLY_PREMIUM = 1.3;
export const WEEKS_PER_MONTH_FOR_PRICING = 4;
export const PRICE_ROUNDING_STEP_PENCE = 50;
/** Yearly = 10 × monthly, paid upfront ("2 months free"). */
export const YEARLY_MONTHS_CHARGED = 10;

/** Round `pence` UP to a multiple of `step` (942.5 → 950 with a 50p step). */
export function roundUpToStep(pence: number, step: number): number {
  if (!(step > 0)) throw new RangeError('step must be positive');
  return Math.ceil(pence / step - 1e-9) * step;
}

export function weeklyPricePence(monthly: number): number {
  return roundUpToStep(
    (monthly / WEEKS_PER_MONTH_FOR_PRICING) * WEEKLY_PREMIUM,
    PRICE_ROUNDING_STEP_PENCE,
  );
}

export function yearlyPricePence(monthly: number): number {
  return monthly * YEARLY_MONTHS_CHARGED;
}

/** What `plan` costs per billing period on `interval`, in pence excl. VAT (the seed amounts). */
export function planPricePence(plan: PlanId, interval: PlanInterval): number {
  const monthly = STUDIO_PLANS[plan].monthlyPence;
  if (interval === 'week') return weeklyPricePence(monthly);
  return interval === 'year' ? yearlyPricePence(monthly) : monthly;
}

const INTERVAL_WORD: Readonly<Record<PlanInterval, string>> = {
  week: 'weekly',
  month: 'monthly',
  year: 'yearly',
};

/** The Stripe Price lookup key: studio_<plan>_<weekly|monthly|yearly>. */
export function planLookupKey(plan: PlanId, interval: PlanInterval): string {
  return `studio_${plan}_${INTERVAL_WORD[interval]}`;
}

/** The Stripe product id of a plan (one product per plan, three recurring prices each). */
export function planProductId(plan: PlanId): string {
  return `studio_plan_${plan}`;
}

/** Every plan price's lookup key (9). */
export function planLookupKeys(): string[] {
  return PLAN_IDS.flatMap((plan) => PLAN_INTERVALS.map((i) => planLookupKey(plan, i)));
}

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && (PLAN_IDS as readonly string[]).includes(value);
}

export function isPlanInterval(value: unknown): value is PlanInterval {
  return typeof value === 'string' && (PLAN_INTERVALS as readonly string[]).includes(value);
}

/** Throws a ValidationError unless `choice` names a plan and an interval. */
export function assertPlanChoice(choice: { plan: unknown; interval: unknown }): PlanChoice {
  if (!isPlanId(choice.plan) || !isPlanInterval(choice.interval))
    throw new ValidationError('Choose Starter, Growth or Pro and weekly, monthly or yearly', {
      plan: String(choice.plan),
      interval: String(choice.interval),
    });
  return { plan: choice.plan, interval: choice.interval };
}

/** A plan price's lookup key → plan and interval (undefined for any other key). */
export function planChoiceForLookupKey(
  lookupKey: string | null | undefined,
): PlanChoice | undefined {
  for (const plan of PLAN_IDS)
    for (const interval of PLAN_INTERVALS)
      if (planLookupKey(plan, interval) === lookupKey) return { plan, interval };
  return undefined;
}

// ------------------------------------------------------------------ 21.5 back-compat

/** The 21.5 per-channel prices (quantity = channels). Still read; no longer sold. */
export const LEGACY_CHANNEL_LOOKUP_KEYS: Readonly<Record<PlanInterval, string>> = Object.freeze({
  week: 'studio_channel_weekly',
  month: 'studio_channel_monthly',
  year: 'studio_channel_yearly',
});

export function legacyChannelIntervalForLookupKey(
  lookupKey: string | null | undefined,
): PlanInterval | undefined {
  return PLAN_INTERVALS.find((i) => LEGACY_CHANNEL_LOOKUP_KEYS[i] === lookupKey);
}

/** A 21.5 channel count's plan: 1 → starter, 2–3 → growth, 4 or more → pro. */
export function planForChannelCount(channels: number): PlanId {
  if (!Number.isFinite(channels) || channels <= 1) return 'starter';
  return channels <= 3 ? 'growth' : 'pro';
}

/** The old self-serve tiers' plans (the 21.5 Basic → 1, Standard → 3, Plus → 6 channels). */
export const LEGACY_TIER_PLANS: Readonly<Record<'BASIC' | 'STANDARD' | 'PLUS', PlanId>> =
  Object.freeze({ BASIC: 'starter', STANDARD: 'growth', PLUS: 'pro' });

/**
 * The plan a subscription pays for: a plan price, or a legacy per-channel price mapped by its
 * quantity (`legacy` true). null for any other price (old tier keys, ENTERPRISE, none).
 */
export function planOfSubscription(facts: {
  lookupKey: string | null | undefined;
  quantity?: number | null;
}): (PlanChoice & { legacy: boolean }) | null {
  const choice = planChoiceForLookupKey(facts.lookupKey);
  if (choice) return { ...choice, legacy: false };
  const interval = legacyChannelIntervalForLookupKey(facts.lookupKey);
  if (!interval) return null;
  return { plan: planForChannelCount(facts.quantity ?? 1), interval, legacy: true };
}

// ------------------------------------------------------------------ allowance

export type AllowanceWindowKind = 'week' | 'month';

/** Where each interval's allowance is counted. */
export const ALLOWANCE_WINDOW: Readonly<Record<PlanInterval, AllowanceWindowKind>> = Object.freeze({
  week: 'week',
  month: 'month',
  year: 'month',
});

/** HD videos per allowance window (weekly: per ISO week; monthly and yearly: per calendar month). */
export function allowancePerWindow(plan: PlanId, interval: PlanInterval): number {
  const def = STUDIO_PLANS[plan];
  return ALLOWANCE_WINDOW[interval] === 'week' ? def.videosPerWeek : def.videosPerMonth;
}

export interface AllowanceWindow {
  /** 'YYYY-MM' (calendar month) or 'YYYY-Www' (ISO week). */
  key: string;
  start: Date;
  /** Exclusive: when the allowance resets. */
  end: Date;
}

const DAY_MS = 86_400_000;

export function calendarMonthWindow(now: number): AllowanceWindow {
  const d = new Date(now);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const key = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
  return { key, start, end };
}

/** The ISO-8601 week (Monday 00:00 UTC to the next Monday) holding `now`. */
export function isoWeekWindow(now: number): AllowanceWindow {
  const d = new Date(now);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const weekday = (d.getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  const start = new Date(midnight - weekday * DAY_MS);
  const end = new Date(start.getTime() + 7 * DAY_MS);
  // ISO week-year: the year of the week's Thursday.
  const thursday = new Date(start.getTime() + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Weekday = (new Date(jan4).getUTCDay() + 6) % 7;
  const week1Monday = jan4 - jan4Weekday * DAY_MS;
  const week = Math.round((start.getTime() - week1Monday) / (7 * DAY_MS)) + 1;
  return { key: `${year}-W${String(week).padStart(2, '0')}`, start, end };
}

export function allowanceWindowFor(kind: AllowanceWindowKind, now: number): AllowanceWindow {
  return kind === 'week' ? isoWeekWindow(now) : calendarMonthWindow(now);
}

/** Whether `key` is an ISO-week window key ('2026-W40'). */
export function isWeekWindowKey(key: string): boolean {
  return /^\d{4}-W\d{2}$/.test(key);
}

// ------------------------------------------------------------------ internal cost caps

/**
 * Cost caps scale with the plan's videos (internal: never shown to customers). Sized to the most
 * videos the plan can make in one calendar month × the typical cost of a short (~241p: Seedance
 * 2.0 full at 720p, coordinator 2026-10-04), plus 25 % headroom (~£3.01 a video); the daily cap
 * is half of that, so a "Plan my month" batch can still run in one day.
 */
export const CAP_PENCE_PER_VIDEO = 241;
export const CAP_HEADROOM = 1.25;

/** Most allowance one calendar month can hold: weekly plans touch up to 5 ISO weeks. */
export function maxVideosPerCalendarMonth(plan: PlanId, interval: PlanInterval): number {
  const perWindow = allowancePerWindow(plan, interval);
  return ALLOWANCE_WINDOW[interval] === 'week' ? perWindow * 5 : perWindow;
}

export function planCostCapsPence(
  plan: PlanId,
  interval: PlanInterval,
): { dailyPence: number; monthlyPence: number } {
  const monthlyPence = Math.ceil(
    maxVideosPerCalendarMonth(plan, interval) * CAP_PENCE_PER_VIDEO * CAP_HEADROOM,
  );
  return { dailyPence: Math.ceil(monthlyPence / 2), monthlyPence };
}

// ------------------------------------------------------------------ plan changes

const PLAN_RANK: Readonly<Record<PlanId, number>> = { starter: 0, growth: 1, pro: 2 };
const INTERVAL_RANK: Readonly<Record<PlanInterval, number>> = { week: 0, month: 1, year: 2 };

/**
 * When a change applies (operator rule: upgrades now with proration, downgrades at period end):
 *   - a higher plan (starter → growth → pro) is an upgrade: now, whatever the interval;
 *   - a lower plan is a downgrade: at the end of the current period;
 *   - the same plan: a longer interval (week → month → year) now (Stripe credits the unused time
 *     and starts the new period today), a shorter one at the end of the period.
 */
export type PlanChangeTiming = 'none' | 'now' | 'period_end';

export function planChangeTiming(current: PlanChoice, next: PlanChoice): PlanChangeTiming {
  const plan = PLAN_RANK[next.plan] - PLAN_RANK[current.plan];
  if (plan !== 0) return plan > 0 ? 'now' : 'period_end';
  const interval = INTERVAL_RANK[next.interval] - INTERVAL_RANK[current.interval];
  if (interval === 0) return 'none';
  return interval > 0 ? 'now' : 'period_end';
}
