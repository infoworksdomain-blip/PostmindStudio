// Prices quoted in tour text, derived from the catalogue so the tour never drifts from the price
// list (catalogue.ts REFERENCE_PRICES_PENCE, channel-plan.ts, ENTERPRISE_LIST_PRICE_PENCE).
// 21.5: customers see the per-channel prices and the HD video packs; the Enterprise figures are
// for the staff (Admin Centre) walkthroughs only.
import {
  ENTERPRISE_LIST_PRICE_PENCE,
  PLAN_CATALOGUE,
  REFERENCE_PRICES_PENCE,
  enterpriseMinimumMonthlyPricePence,
} from '@/lib/studio/billing/catalogue';
import { CHANNEL_PRICE_PENCE } from '@/lib/studio/billing/channel-plan';

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
  channelMonthly: money(CHANNEL_PRICE_PENCE.month),
  channelWeekly: money(CHANNEL_PRICE_PENCE.week),
  channelYearly: money(CHANNEL_PRICE_PENCE.year),
  packHd5: money(REFERENCE_PRICES_PENCE.studio_pack_hd5 ?? 0),
  packHd15: money(REFERENCE_PRICES_PENCE.studio_pack_hd15 ?? 0),
  enterpriseCap: pounds(enterpriseCap),
  enterpriseMinimum: pounds(enterpriseMinimumMonthlyPricePence(enterpriseCap)),
  enterpriseList: pounds(ENTERPRISE_LIST_PRICE_PENCE),
} as const;
