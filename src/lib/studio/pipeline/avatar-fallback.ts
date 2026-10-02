import {
  KillSwitchTriggeredError,
  NoProviderAvailableError,
  ProvidersUnavailableError,
} from '../../errors';
import { isAccountProviderError } from '../providers/account-errors';

// BACKLOG 20.19 (production 2026-10-02): HeyGen ran out of API credits, three AI_AVATAR shots
// failed and the whole video failed with asset_generation_failed although every other layer
// worked. When the presenter cannot be produced because NO avatar provider is available —
// account problem / hold (20.11), provider-level kill switch, open breaker, nothing configured —
// the shot degrades to a regular generated clip (text_to_video through the router: Seedance,
// Veo, Runway, Luma) that illustrates the narration. The shot keeps its narration (generated first for the avatar)
// and its duration, so composition lines up. A content refusal, a validation error, a cost-cap
// pause or a workspace / project / global kill switch is NOT an availability problem: those fail
// (or pause) the shot as before.

export const DEGRADED_FROM_AVATAR = 'avatar_video';

/** Runway clips are 2–10 s (scripting.ts shotDurationBounds); the composer trims to the shot. */
const CLIP_MIN_SEC = 2;
const CLIP_MAX_SEC = 10;
/** Conservative prompt cap, well inside every text_to_video adapter's limit. */
const PROMPT_MAX_CHARS = 900;

/** Skip reasons that say why a provider could not be used right now (router.ts SkipReason). */
const RUNTIME_SKIPS = [
  'account_unavailable',
  'provider_disabled',
  'circuit_open',
  'over_budget',
  'too_slow',
  'no_cost_estimate',
] as const;

function skipReasonOf(err: NoProviderAvailableError): string {
  const candidates = err.details?.candidates;
  const skipped = Array.isArray(candidates)
    ? candidates.flatMap((c: unknown) => {
        const reason = (c as { skipped?: unknown } | null)?.skipped;
        return typeof reason === 'string' ? [reason] : [];
      })
    : [];
  return RUNTIME_SKIPS.find((r) => skipped.includes(r)) ?? 'not_configured';
}

/**
 * The reason code when `err` means "no avatar provider is available", or null when the shot
 * should fail as before (content refusal, invalid request, cost-cap pause, broader kill switch…).
 */
export function avatarUnavailableReason(err: unknown): string | null {
  if (err instanceof ProvidersUnavailableError) {
    return err.failures[0]?.errorClass ?? 'providers_unavailable';
  }
  if (err instanceof NoProviderAvailableError) return skipReasonOf(err);
  // runProvider fails over on account errors itself; this covers a direct adapter error.
  if (isAccountProviderError(err)) return err.errorClass;
  if (err instanceof KillSwitchTriggeredError && err.level === 'provider') {
    return 'provider_disabled';
  }
  return null;
}

/** The generation length for the replacement clip (the shot keeps its own duration). */
export function degradedClipDurationSec(shotDurationSec: number): number {
  return Math.min(CLIP_MAX_SEC, Math.max(CLIP_MIN_SEC, Math.ceil(shotDurationSec)));
}

function clean(text: string | null | undefined, max: number): string {
  return (text ?? '').replace(/\s+/g, ' ').replace(/"/g, "'").trim().slice(0, max);
}

/**
 * B-roll prompt for an avatar shot with no presenter: what the narration says, shown rather than
 * spoken to camera. The scene description was written for a presenter, so it is context only.
 */
export function degradedClipPrompt(input: {
  sceneDescription: string;
  voiceoverText: string | null;
  cameraDirection?: string | null;
  toneKeywords?: readonly string[];
}): string {
  const line = clean(input.voiceoverText, 300);
  const scene = clean(input.sceneDescription, 250);
  const camera = clean(input.cameraDirection, 80);
  const tone = (input.toneKeywords ?? [])
    .map((k) => clean(k, 30))
    .filter(Boolean)
    .slice(0, 4)
    .join(', ');
  const parts = [
    line
      ? `Cinematic B-roll that visually illustrates this line: "${line}".`
      : 'Cinematic B-roll for a short brand video.',
    scene && `Setting and context: ${scene}.`,
    'No presenter, nobody speaking to camera, no on-screen text, logos or captions.',
    tone ? `Polished, brand-appropriate look; mood: ${tone}.` : 'Polished, brand-appropriate look.',
    camera && `Camera: ${camera}.`,
  ];
  return parts.filter(Boolean).join(' ').slice(0, PROMPT_MAX_CHARS);
}

export interface DegradedShot {
  shotId: string;
  degradedFrom: string;
  reason: string;
}

/** Shots of a run whose visual was degraded (providerRouting.visual.degradedFrom). */
export function degradedShotsOf(
  shots: ReadonlyArray<{ id: string; providerRouting: unknown }>,
): DegradedShot[] {
  return shots.flatMap((shot) => {
    const routing = shot.providerRouting as { visual?: unknown } | null;
    const visual = routing?.visual as { degradedFrom?: unknown; degradedReason?: unknown } | null;
    if (!visual || typeof visual.degradedFrom !== 'string') return [];
    return [
      {
        shotId: shot.id,
        degradedFrom: visual.degradedFrom,
        reason: typeof visual.degradedReason === 'string' ? visual.degradedReason : 'unknown',
      },
    ];
  });
}
