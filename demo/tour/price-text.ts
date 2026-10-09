// Prices quoted in tour text, derived from the catalogue so the tour never drifts from the price
// list (catalogue.ts REFERENCE_PRICES_PENCE, plans.ts, ENTERPRISE_LIST_PRICE_PENCE).
// 26.1: customers see the Starter / Growth / Pro prices and the HD video packs; the Enterprise
// figures are for the staff (Admin Centre) walkthroughs only.
import {
  ENTERPRISE_LIST_PRICE_PENCE,
  PLAN_CATALOGUE,
  REFERENCE_PRICES_PENCE,
  enterpriseMinimumMonthlyPricePence,
} from '@/lib/studio/billing/catalogue';
import { planPricePence } from '@/lib/studio/billing/plans';

/** Whole pounds, e.g. 141_600 → "£1,416". */
export const pounds = (pence: number): string =>
  `£${Math.round(pence / 100).toLocaleString('en-GB')}`;

/** Pounds and pence when there are pence, e.g. 950 → "£9.50", 2_900 → "£29". */
export const money = (pence: number): string =>
  pence % 100 === 0
    ? pounds(pence)
    : `£${(pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2 })}`;

const enterpriseCap = PLAN_CATALOGUE.ENTERPRISE.monthlyCostCapPence;

export const PRICE_TEXT = {
  starterMonthly: money(planPricePence('starter', 'month')),
  growthMonthly: money(planPricePence('growth', 'month')),
  growthWeekly: money(planPricePence('growth', 'week')),
  growthYearly: money(planPricePence('growth', 'year')),
  proMonthly: money(planPricePence('pro', 'month')),
  proYearly: money(planPricePence('pro', 'year')),
  packHd5: money(REFERENCE_PRICES_PENCE.studio_pack_hd5 ?? 0),
  packHd15: money(REFERENCE_PRICES_PENCE.studio_pack_hd15 ?? 0),
  enterpriseCap: pounds(enterpriseCap),
  enterpriseMinimum: pounds(enterpriseMinimumMonthlyPricePence(enterpriseCap)),
  enterpriseList: pounds(ENTERPRISE_LIST_PRICE_PENCE),
} as const;
