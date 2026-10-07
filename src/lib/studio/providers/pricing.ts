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
 * BACKLOG 24.1 — fal.ai video models (providers/fal-models.ts), USD per second of output video at
 * the resolution Studio requests. fal bills per second from a prepaid balance. Sources (read
 * 2026-10-06):
 *   minimax-h3-max: https://fal.ai/models/minimax/h3-max/text-to-video and
 *     https://fal.ai/models/minimax/h3-max/image-to-video — "480p is $0.05/second, 768p is
 *     $0.08/second, and 1080p is $0.16/second" (the regular rate; a 40%-off promotion runs until
 *     15 October, recorded at the regular rate so cost caps stay conservative).
 *   ltx-2.3-fast: https://fal.ai/models/fal-ai/ltx-2.3/text-to-video/fast/llms.txt and
 *     .../image-to-video/fast/llms.txt — "$0.06 per second for 1080p" (the model page's table shows
 *     $0.04/s; the higher documented figure is used). 1080p is the smallest resolution offered.
 *   veo-3.1-lite: https://fal.ai/models/fal-ai/veo3.1/lite/llms.txt and
 *     .../lite/image-to-video/llms.txt — "$0.03 for 720p without audio … $0.05 for 1080p without
 *     audio" (Studio always asks for silent clips).
 */
export const FAL_VIDEO_USD_PER_SECOND = {
  'minimax-h3-max': { '480P': 0.05, '768P': 0.08, '1080P': 0.16 },
  'ltx-2.3-fast': { '1080p': 0.06 },
  'veo-3.1-lite': { '720p': 0.03, '1080p': 0.05 },
} as const;

/**
 * Convert USD to whole pence, rounding UP. Provider calls often cost fractions of a penny;
 * rounding up keeps cost caps (spec 12.5) conservative rather than letting spend hide.
 */
export function usdToPence(usd: number, usdToGbpRate: number): number {
  if (usd <= 0) return 0;
  // Round to 6 dp first so float noise (e.g. 0.30000000000000004) doesn't add a penny.
  return Math.ceil(Number((usd * usdToGbpRate * 100).toFixed(6)));
}
