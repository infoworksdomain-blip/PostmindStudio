import { ConfigurationError } from '../../errors';
import { PLAN_CATALOGUE, TIER_ORDER } from '../billing/catalogue';
import type { PlanTier } from '../providers/router';

// Spec 12.5 cost caps (all in GBP pence of provider spend). Operator decision 2 (2026-09-27)
// sets the defaults below; every one can be overridden per environment:
//   STUDIO_ORG_DAILY_CAP_PENCE_<TIER>     one organisation, all providers, per UTC day
//   STUDIO_ORG_MONTHLY_CAP_PENCE_<TIER>   one organisation, all providers, per calendar month UTC
//   STUDIO_GLOBAL_DAILY_CAP_PENCE         every organisation together, per UTC day
//   STUDIO_ORG_PROVIDER_DAILY_CAP_PENCE   one organisation × one provider × day (spec 11.4; no
//                                         default, unset = no cap, unchanged semantics)
// Env value rules for the three defaulted caps:
//   unset or blank       → the code default (source "default")
//   a positive integer   → that cap (source "env")
//   "0", "none" or "off" → the cap is disabled (source "disabled"), i.e. no cap at all
//   anything else        → ConfigurationError at startup
// The per-project cap is video_projects.costBudgetPence; when the client sends none, project
// creation applies defaultProjectBudgetPence (cost/project-budget.ts).

export const PLAN_TIERS: readonly PlanTier[] = TIER_ORDER;

function byTier(pick: (tier: PlanTier) => number): Readonly<Record<PlanTier, number>> {
  return Object.freeze(Object.fromEntries(PLAN_TIERS.map((t) => [t, pick(t)]))) as Record<
    PlanTier,
    number
  >;
}

/**
 * Price list 2026-09-30: £5 / £15 / £45 / £150 per organisation per UTC day. Phase 18 §P.3: read
 * from the plan catalogue (billing/catalogue.ts); the env overrides below still win.
 */
export const DEFAULT_ORG_DAILY_CAP_PENCE = byTier((t) => PLAN_CATALOGUE[t].dailyCostCapPence);
/** Price list 2026-09-30: £20 / £73 / £264 / £1,100 per organisation per calendar month (UTC). */
export const DEFAULT_ORG_MONTHLY_CAP_PENCE = byTier((t) => PLAN_CATALOGUE[t].monthlyCostCapPence);
/** Operator decision 2: £2,500 per UTC day across every organisation. */
export const DEFAULT_GLOBAL_DAILY_CAP_PENCE = 250_000;

/** Project: alert at 80%, pause at 90% (spec 12.5), alert at 100%. */
export const PROJECT_THRESHOLDS = [80, 90, 100] as const;
export const PROJECT_PAUSE_PERCENT = 90;
/** Daily and monthly caps: alert at 80%, alert + pause at 100%. */
export const DAILY_THRESHOLDS = [80, 100] as const;
export const MONTHLY_THRESHOLDS = DAILY_THRESHOLDS;

/** Where an effective cap value came from (admin report). */
export type CapSource = 'default' | 'env' | 'disabled';

export interface CapSources {
  orgDailyByTier: Record<PlanTier, CapSource>;
  orgMonthlyByTier: Record<PlanTier, CapSource>;
  globalDaily: CapSource;
}

export interface CostCaps {
  orgProviderDailyPence?: number;
  orgDailyPenceByTier: Partial<Record<PlanTier, number>>;
  /** Absent or missing tier = no monthly cap for that tier. */
  orgMonthlyPenceByTier?: Partial<Record<PlanTier, number>>;
  globalDailyPence?: number;
  /** Set by costCapsFromEnv; absent for caps built by hand (tests). */
  sources?: CapSources;
}

type Env = Record<string, string | undefined>;

const DISABLED_VALUES = new Set(['0', 'none', 'off']);

function parsePence(name: string, raw: string): number {
  const cap = Number(raw);
  if (!Number.isSafeInteger(cap) || cap < 0) {
    throw new ConfigurationError(
      `${name} must be a non-negative integer (pence), or "none" / "off" / "0" to disable`,
    );
  }
  return cap;
}

/** Unset = no cap (the provider cap has no default and keeps its original semantics). */
function parseOptionalCap(env: Env, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  return parsePence(name, raw.trim());
}

/** A cap with a code default: see the value rules at the top of this file. */
export function resolveCap(
  env: Env,
  name: string,
  fallback: number,
): { pence: number | undefined; source: CapSource } {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return { pence: fallback, source: 'default' };
  if (DISABLED_VALUES.has(raw.toLowerCase())) return { pence: undefined, source: 'disabled' };
  return { pence: parsePence(name, raw), source: 'env' };
}

function resolveTiers(env: Env, prefix: string, defaults: Readonly<Record<PlanTier, number>>) {
  const pence: Partial<Record<PlanTier, number>> = {};
  const sources = {} as Record<PlanTier, CapSource>;
  for (const tier of PLAN_TIERS) {
    const cap = resolveCap(env, `${prefix}${tier}`, defaults[tier]);
    if (cap.pence !== undefined) pence[tier] = cap.pence;
    sources[tier] = cap.source;
  }
  return { pence, sources };
}

export function costCapsFromEnv(env: Env = process.env): CostCaps {
  const daily = resolveTiers(env, 'STUDIO_ORG_DAILY_CAP_PENCE_', DEFAULT_ORG_DAILY_CAP_PENCE);
  const monthly = resolveTiers(env, 'STUDIO_ORG_MONTHLY_CAP_PENCE_', DEFAULT_ORG_MONTHLY_CAP_PENCE);
  const global = resolveCap(env, 'STUDIO_GLOBAL_DAILY_CAP_PENCE', DEFAULT_GLOBAL_DAILY_CAP_PENCE);
  return {
    orgProviderDailyPence: parseOptionalCap(env, 'STUDIO_ORG_PROVIDER_DAILY_CAP_PENCE'),
    orgDailyPenceByTier: daily.pence,
    orgMonthlyPenceByTier: monthly.pence,
    globalDailyPence: global.pence,
    sources: {
      orgDailyByTier: daily.sources,
      orgMonthlyByTier: monthly.sources,
      globalDaily: global.source,
    },
  };
}

/** Thresholds (percent) that `spent` has reached against `cap`. A zero cap raises no alerts. */
export function crossedThresholds(
  spentPence: number,
  capPence: number,
  thresholds: readonly number[],
): number[] {
  if (capPence <= 0) return [];
  return thresholds.filter((t) => spentPence * 100 >= capPence * t);
}

/** Whole percent of the cap used (null when there is no cap to compare against). */
export function percentOf(spentPence: number, capPence: number): number | null {
  if (capPence <= 0) return null;
  return Math.floor((spentPence * 100) / capPence);
}

/** YYYY-MM-DD for the UTC day of `at`. */
export function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** YYYY-MM for the UTC calendar month of `at` (monthly cap alert period). */
export function utcMonthKey(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/** [first day of the UTC month of `at`, first day of the next month) as @db.Date values. */
export function utcMonthRange(at: Date): { start: Date; end: Date } {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
}
