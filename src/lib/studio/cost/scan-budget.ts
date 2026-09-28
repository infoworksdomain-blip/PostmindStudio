import { logger } from '../../logger';
import type { BudgetChecker } from '../providers/router';

// BACKLOG 15.D2 / Addendum A10.4: "Feature D scan: single scan hard-capped at £0.50 (99th
// percentile is well below this)." Scans have no project budget, so the scan worker routes its
// provider calls (classification, embeddings) through this checker: each call the router accepts
// reserves its estimated cost, and a call whose estimate would take the scan past the cap is
// refused (the router then answers NoProviderAvailableError / over_budget). Reservations are
// estimates — conservative, never refunded — and the scan also records its actual cost
// (website_scans.costPence). The organisation and global caps (the wrapped checker) still apply.

export const DEFAULT_SCAN_COST_CAP_PENCE = 50;

/** STUDIO_SCAN_COST_CAP_PENCE overrides the A10.4 £0.50 cap (a positive integer, pence). */
export function scanCostCapPence(env: Record<string, string | undefined> = process.env): number {
  const raw = env.STUDIO_SCAN_COST_CAP_PENCE?.trim();
  if (!raw) return DEFAULT_SCAN_COST_CAP_PENCE;
  if (/^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
  logger.warn({ value: raw }, '[scan-budget] invalid STUDIO_SCAN_COST_CAP_PENCE; using £0.50');
  return DEFAULT_SCAN_COST_CAP_PENCE;
}

export interface ScanBudget extends BudgetChecker {
  readonly capPence: number;
  /** Estimated pence reserved by the calls accepted so far. */
  reservedPence(): number;
  /** True once a call was refused because it would have passed the scan cap. */
  capReached(): boolean;
}

export function createScanBudget(inner: BudgetChecker, capPence: number): ScanBudget {
  let reserved = 0;
  let refused = false;
  return {
    capPence,
    reservedPence: () => reserved,
    capReached: () => refused,
    async hasBudget(input) {
      if (reserved + input.estimatedCostPence > capPence) {
        refused = true;
        return false;
      }
      if (!(await inner.hasBudget(input))) return false;
      reserved += input.estimatedCostPence;
      return true;
    },
    ...(inner.assertNotPaused && {
      assertNotPaused: (scope: Parameters<NonNullable<BudgetChecker['assertNotPaused']>>[0]) =>
        inner.assertNotPaused?.(scope) ?? Promise.resolve(),
    }),
    ...(inner.recordSpend && {
      recordSpend: (scope: Parameters<NonNullable<BudgetChecker['recordSpend']>>[0]) =>
        inner.recordSpend?.(scope) ?? Promise.resolve(),
    }),
  };
}
