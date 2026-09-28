import { z } from 'zod';

// BACKLOG 15.B9 — spec 20: "user notified of quality tier drop if fallback used". The router
// records every candidate it considered, in the tier's preference order, with the reason a
// candidate was skipped (providers/router.ts CandidateOutcome). A generation used a fallback when
// an earlier candidate was passed over for a run-time reason (disabled by the kill switch, over
// budget, too slow, circuit open, no cost estimate). A provider this deployment has not configured
// at all is not a drop in quality for this video, so it is not reported.

export const RUNTIME_SKIP_REASONS = new Set([
  'provider_disabled',
  'over_budget',
  'too_slow',
  'no_cost_estimate',
  'circuit_open',
]);

export type FallbackLayer = 'visual' | 'voice' | 'music' | 'composition';

export interface FallbackNotice {
  layer: FallbackLayer;
  shotId?: string;
  /** The provider that produced the output. */
  usedProviderId: string;
  /** Preferred providers that were passed over, and why. */
  skipped: Array<{ providerId: string; reason: string }>;
}

const snapshot = z.object({
  providerId: z.string(),
  candidates: z.array(z.object({ providerId: z.string(), skipped: z.string().optional() })),
});

/** The notice for one routing snapshot ({ providerId, candidates }), or null when none is due. */
export function fallbackFrom(
  routing: unknown,
  layer: FallbackLayer,
  shotId?: string,
): FallbackNotice | null {
  const parsed = snapshot.safeParse(routing);
  if (!parsed.success) return null;
  const { providerId, candidates } = parsed.data;
  const skipped: FallbackNotice['skipped'] = [];
  for (const c of candidates) {
    if (c.providerId === providerId && !c.skipped) break;
    if (c.skipped && RUNTIME_SKIP_REASONS.has(c.skipped))
      skipped.push({ providerId: c.providerId, reason: c.skipped });
  }
  if (skipped.length === 0) return null;
  return { layer, usedProviderId: providerId, skipped, ...(shotId && { shotId }) };
}

/** Notices for a shot's stored providerRouting ({ visual?, voice? }). */
export function shotFallbacks(shotId: string, providerRouting: unknown): FallbackNotice[] {
  if (!providerRouting || typeof providerRouting !== 'object') return [];
  const routing = providerRouting as Record<string, unknown>;
  return [
    fallbackFrom(routing.visual, 'visual', shotId),
    fallbackFrom(routing.voice, 'voice', shotId),
  ].filter((n): n is FallbackNotice => n !== null);
}

export const fallbackNoticeSchema = z.object({
  layer: z.enum(['visual', 'voice', 'music', 'composition']),
  shotId: z.string().optional(),
  usedProviderId: z.string(),
  skipped: z.array(z.object({ providerId: z.string(), reason: z.string() })),
});
