// Prices quoted in tour text, derived from the plan catalogue so the tour never drifts from the
// price list (catalogue.ts REFERENCE_PRICES_PENCE, ENTERPRISE_LIST_PRICE_PENCE).
import {
  ENTERPRISE_LIST_PRICE_PENCE,
  PLAN_CATALOGUE,
  REFERENCE_PRICES_PENCE,
  enterpriseMinimumMonthlyPricePence,
} from '@/lib/studio/billing/catalogue';

/** Whole pounds, e.g. 141_600 → "£1,416". */
export const pounds = (pence: number): string =>
  `£${Math.round(pence / 100).toLocaleString('en-GB')}`;

const enterpriseCap = PLAN_CATALOGUE.ENTERPRISE.monthlyCostCapPence;

export const PRICE_TEXT = {
  basicShortTopUp: pounds(REFERENCE_PRICES_PENCE.studio_topup_short10_basic ?? 0),
  enterpriseCap: pounds(enterpriseCap),
  enterpriseMinimum: pounds(enterpriseMinimumMonthlyPricePence(enterpriseCap)),
  enterpriseList: pounds(ENTERPRISE_LIST_PRICE_PENCE),
} as const;
