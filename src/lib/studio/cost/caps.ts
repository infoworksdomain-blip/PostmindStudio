import { ConfigurationError } from '../../errors';
import type { PlanTier } from '../providers/router';

// Spec 12.5 cost caps, configured per environment (all in GBP pence, per UTC day). Unset or
// empty = no cap. The per-project cap is video_projects.costBudgetPence (set per project).
//   STUDIO_ORG_PROVIDER_DAILY_CAP_PENCE   one organisation × one provider × day (spec 11.4)
//   STUDIO_ORG_DAILY_CAP_PENCE_<TIER>     one organisation, all providers, by plan tier
//   STUDIO_GLOBAL_DAILY_CAP_PENCE         every organisation together (Studio-owned budgets)

export const PLAN_TIERS: readonly PlanTier[] = ['BASIC', 'STANDARD', 'PLUS', 'ENTERPRISE'];

/** Project: alert at 80%, pause at 90% (spec 12.5), alert at 100%. */
export const PROJECT_THRESHOLDS = [80, 90, 100] as const;
export const PROJECT_PAUSE_PERCENT = 90;
/** Daily caps: alert at 80%, alert + pause at 100%. */
export const DAILY_THRESHOLDS = [80, 100] as const;

export interface CostCaps {
  orgProviderDailyPence?: number;
  orgDailyPenceByTier: Partial<Record<PlanTier, number>>;
  globalDailyPence?: number;
}

type Env = Record<string, string | undefined>;

function parseCap(env: Env, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const cap = Number(raw.trim());
  if (!Number.isSafeInteger(cap) || cap < 0) {
    throw new ConfigurationError(`${name} must be a non-negative integer (pence)`);
  }
  return cap;
}

export function costCapsFromEnv(env: Env = process.env): CostCaps {
  const orgDailyPenceByTier: Partial<Record<PlanTier, number>> = {};
  for (const tier of PLAN_TIERS) {
    const cap = parseCap(env, `STUDIO_ORG_DAILY_CAP_PENCE_${tier}`);
    if (cap !== undefined) orgDailyPenceByTier[tier] = cap;
  }
  return {
    orgProviderDailyPence: parseCap(env, 'STUDIO_ORG_PROVIDER_DAILY_CAP_PENCE'),
    orgDailyPenceByTier,
    globalDailyPence: parseCap(env, 'STUDIO_GLOBAL_DAILY_CAP_PENCE'),
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
