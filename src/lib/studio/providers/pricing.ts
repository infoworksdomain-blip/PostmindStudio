import { requireEnv } from '../../env';
import { ConfigurationError } from '../../errors';

// Providers bill in USD; Studio records cost in integer GBP pence (spec 7.1 costPence,
// costCurrency "GBP"). The conversion rate is operator configuration, never hardcoded.

export function usdToGbpRateFromEnv(): number {
  const raw = requireEnv('STUDIO_USD_TO_GBP_RATE');
  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 5) {
    throw new ConfigurationError('STUDIO_USD_TO_GBP_RATE must be a positive number such as 0.75');
  }
  return rate;
}

/**
 * Convert USD to whole pence, rounding UP. Provider calls often cost fractions of a penny;
 * rounding up keeps cost caps (spec 12.5) conservative rather than letting spend hide.
 */
export function usdToPence(usd: number, usdToGbpRate: number): number {
  if (usd <= 0) return 0;
  // Round to 6 dp first so float noise (e.g. 0.30000000000000004) doesn't add a penny.
  return Math.ceil(Number((usd * usdToGbpRate * 100).toFixed(6)));
}
