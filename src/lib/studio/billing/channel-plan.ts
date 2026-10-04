import { ValidationError } from '../../errors';

// Phase 21.5 (operator decision 2026-10-04) — ONE plan: a per-channel subscription.
//
//   A "channel" is a social platform the customer publishes to (TikTok, Instagram, YouTube,
//   Facebook, LinkedIn, X). The customer pays for 1–6 channels; the Stripe subscription has ONE
//   item whose quantity is the number of channels, on one of three recurring prices:
//
//     interval  price per channel           videos per channel   allowance released
//     week      £9.50 (see the rounding)    2 a week             per ISO week (Monday 00:00 UTC)
//     month     £29                         8 a month            per calendar month (UTC)
//     year      £290 (10 × monthly)         96 a year            8 per calendar month (UTC)
//
//   Weekly is deliberately dearer: monthly ÷ 4 × 1.3 = £9.425, ROUNDED UP to the next 50p
//   (£9.50). Yearly is paid upfront: 10 × monthly ("2 months free").
//
//   DECISION (yearly allowance): the 96 a year are released as 8 per calendar month, the window
//   the existing allowance engine already counts in (plan-quotas.ts, metadata.quotaSlot keyed by
//   'YYYY-MM'). "All at once" would need a new subscription-period counter and would let a yearly
//   customer spend a year of provider cost in the first week, past every monthly cost cap.
//   DECISION (weekly allowance): an ISO week (Monday 00:00 UTC to the next Monday) — the same
//   counting code with a 'YYYY-Www' window key; it is not tied to the Stripe billing anchor.
//
//   Every channel subscription is the internal tier STANDARD (routing, render quality, gates);
//   long videos are not part of the plan (allowance 0, hidden in the customer UI).
//
// Everything here is pure and unit tested (channel-plan.test.ts). Amounts in Stripe are created
// from CHANNEL_PRICE_PENCE by scripts/billing/seed-stripe-test.ts; the app reads live amounts from
// Stripe by lookup key, like before.

export const CHANNEL_PLAN_VERSION = '2026-10-04';

export const MIN_CHANNELS = 1;
export const MAX_CHANNELS = 6;

export type ChannelInterval = 'week' | 'month' | 'year';
export const CHANNEL_INTERVALS: readonly ChannelInterval[] = ['week', 'month', 'year'];

/** The internal tier every channel subscription maps to (routing, quality, cost guards). */
export const CHANNEL_PLAN_TIER = 'STANDARD' as const;

/** The flat reference rate: £29 per channel per month. */
export const MONTHLY_PRICE_PER_CHANNEL_PENCE = 2_900;
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

export function weeklyPricePerChannelPence(monthly = MONTHLY_PRICE_PER_CHANNEL_PENCE): number {
  return roundUpToStep(
    (monthly / WEEKS_PER_MONTH_FOR_PRICING) * WEEKLY_PREMIUM,
    PRICE_ROUNDING_STEP_PENCE,
  );
}

export function yearlyPricePerChannelPence(monthly = MONTHLY_PRICE_PER_CHANNEL_PENCE): number {
  return monthly * YEARLY_MONTHS_CHARGED;
}

/** The per-channel price of each interval (the amounts the Stripe seed creates). */
export const CHANNEL_PRICE_PENCE: Readonly<Record<ChannelInterval, number>> = Object.freeze({
  week: weeklyPricePerChannelPence(),
  month: MONTHLY_PRICE_PER_CHANNEL_PENCE,
  year: yearlyPricePerChannelPence(),
});

/** Stripe Price lookup keys (one product, three recurring prices; quantity = channels). */
export const CHANNEL_LOOKUP_KEYS: Readonly<Record<ChannelInterval, string>> = Object.freeze({
  week: 'studio_channel_weekly',
  month: 'studio_channel_monthly',
  year: 'studio_channel_yearly',
});

/** The Stripe product id the seed creates for the channel prices. */
export const CHANNEL_PRODUCT_ID = 'studio_channel';

export function channelIntervalForLookupKey(lookupKey: string | null | undefined) {
  return CHANNEL_INTERVALS.find((i) => CHANNEL_LOOKUP_KEYS[i] === lookupKey);
}

export function isChannelInterval(value: unknown): value is ChannelInterval {
  return typeof value === 'string' && (CHANNEL_INTERVALS as readonly string[]).includes(value);
}

export function isValidChannelCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_CHANNELS &&
    value <= MAX_CHANNELS
  );
}

/** Throws a ValidationError unless 1 ≤ channels ≤ 6 (an integer). */
export function assertChannelCount(value: number): number {
  if (!isValidChannelCount(value))
    throw new ValidationError(`Choose between ${MIN_CHANNELS} and ${MAX_CHANNELS} channels`, {
      channels: value,
    });
  return value;
}

/**
 * A channel count as Stripe or staff stored it: a whole number of at least 1. Unlike
 * assertChannelCount it allows more than 6 (a subscription edited in the Stripe dashboard).
 */
export function paidChannels(value: number): number {
  if (!Number.isInteger(value) || value < MIN_CHANNELS)
    throw new ValidationError('A channel count must be a whole number of at least 1', {
      channels: value,
    });
  return value;
}

/** What `channels` cost per billing period on `interval`, in pence (excl. VAT). */
export function channelPlanPricePence(
  channels: number,
  interval: ChannelInterval,
  unitPence: number = CHANNEL_PRICE_PENCE[interval],
): number {
  return assertChannelCount(channels) * unitPence;
}

// ------------------------------------------------------------------ allowance

/** Videos included per channel per billing period (week 2, month 8, year 96). */
export const VIDEOS_PER_CHANNEL_PER_PERIOD: Readonly<Record<ChannelInterval, number>> =
  Object.freeze({ week: 2, month: 8, year: 96 });

export type AllowanceWindowKind = 'week' | 'month';

/** Where each interval's allowance is counted (see the DECISIONs above). */
export const ALLOWANCE_WINDOW: Readonly<Record<ChannelInterval, AllowanceWindowKind>> =
  Object.freeze({ week: 'week', month: 'month', year: 'month' });

/** Videos per channel per allowance window (yearly: 96 ÷ 12 = 8 a calendar month). */
export const VIDEOS_PER_CHANNEL_PER_WINDOW: Readonly<Record<ChannelInterval, number>> =
  Object.freeze({ week: 2, month: 8, year: 8 });

export function allowancePerWindow(channels: number, interval: ChannelInterval): number {
  return paidChannels(channels) * VIDEOS_PER_CHANNEL_PER_WINDOW[interval];
}

export function allowancePerPeriod(channels: number, interval: ChannelInterval): number {
  return paidChannels(channels) * VIDEOS_PER_CHANNEL_PER_PERIOD[interval];
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
 * Cost caps scale with channels (internal: never shown to customers). Sized to the most videos
 * the plan can make in one calendar month × the typical cost of a short (~241p: Seedance 2.0 full
 * at 720p on every tier, coordinator 2026-10-04), plus 25 % headroom (~£3.01 a video); the daily
 * cap is half of that, so a "Plan my month" batch can still run in one day.
 */
export const CAP_PENCE_PER_VIDEO = 241;
export const CAP_HEADROOM = 1.25;

/** Most allowance one calendar month can hold: weekly plans touch up to 5 ISO weeks. */
export function maxVideosPerCalendarMonth(channels: number, interval: ChannelInterval): number {
  const perWindow = allowancePerWindow(channels, interval);
  return ALLOWANCE_WINDOW[interval] === 'week' ? perWindow * 5 : perWindow;
}

export function channelCostCapsPence(
  channels: number,
  interval: ChannelInterval,
): { dailyPence: number; monthlyPence: number } {
  const monthlyPence = Math.ceil(
    maxVideosPerCalendarMonth(channels, interval) * CAP_PENCE_PER_VIDEO * CAP_HEADROOM,
  );
  return { dailyPence: Math.ceil(monthlyPence / 2), monthlyPence };
}

// ------------------------------------------------------------------ plan changes

const INTERVAL_RANK: Readonly<Record<ChannelInterval, number>> = { week: 0, month: 1, year: 2 };

export interface ChannelPlanChoice {
  channels: number;
  interval: ChannelInterval;
}

/**
 * When a change applies (operator rule: upgrades now with proration, downgrades at period end):
 *   - a longer interval (week → month → year) is an upgrade: now (Stripe credits the unused
 *     time and starts the new period today);
 *   - a shorter interval is a downgrade: at the end of the current period;
 *   - same interval: more channels now, fewer at the end of the period.
 */
export type PlanChangeTiming = 'none' | 'now' | 'period_end';

export function planChangeTiming(
  current: ChannelPlanChoice,
  next: ChannelPlanChoice,
): PlanChangeTiming {
  if (current.channels === next.channels && current.interval === next.interval) return 'none';
  const from = INTERVAL_RANK[current.interval];
  const to = INTERVAL_RANK[next.interval];
  if (to > from) return 'now';
  if (to < from) return 'period_end';
  return next.channels > current.channels ? 'now' : 'period_end';
}

/** The old self-serve tiers' channel counts in the new model (ops migration, 21.5). */
export const LEGACY_TIER_CHANNELS: Readonly<Record<'BASIC' | 'STANDARD' | 'PLUS', number>> =
  Object.freeze({ BASIC: 1, STANDARD: 3, PLUS: 6 });
