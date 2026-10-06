import type { VisualTreatment } from '@prisma/client';
import type { PlanTier } from '../providers/router';
import type { ProviderRegistry } from '../providers/registry';
import { BUDGET_TREATMENT, CLIP_BUDGET_KEY, beatOf } from '../pipeline/clip-budget';
import { fitDurations, type PlannedScript, type PlannedShot } from '../pipeline/scripting';
import { oneShortLine } from '../overlays/captions';
import { ACTOR_LINE_PADDING_SEC, ACTOR_WORDS_PER_SEC } from './prompt';

// BACKLOG 21.4 — the UGC script after Layer 2: which treatments it may use, how many actor clips
// it may buy, and the rules that make it executable:
//   - actor clips are exactly one of the provider's clip lengths (Veo: 4, 6 or 8 s; 8 s when the
//     product image is sent as a reference), long enough for their line;
//   - extra actor shots over the budget become product stills (never a paid generation), their
//     line moved on screen;
//   - only actor shots speak: a B-roll shot's voiceover would need a second, different voice
//     (ElevenLabs) in the same video, so it is moved on screen too;
//   - the other shots absorb the time so the script still lasts its target.
// 21.4b (production UGC video 2, 2026-10-05: "the poster in between does not work"): the only
// B-roll is a 2–3 s product still with at most one short line; a TEXT_CARD or MOTION_GRAPHICS
// shot (or any other kind) in a UGC script becomes that still, so a UGC video never has a card.

/** Veo 3.1 durationSeconds "4", "6" or "8" (https://ai.google.dev/gemini-api/docs/veo, 2026-10-04). */
export const ACTOR_CLIP_SECONDS = [4, 6, 8] as const;
/**
 * "must be "8" when using … reference images" (same page): a product reference forces 8 s, and so
 * does the actor portrait (21.4a, ugc/portrait.ts).
 */
export const ACTOR_CLIP_SECONDS_WITH_PRODUCT = [8] as const;
/** 21.4a: the same lengths, named for what forces them (any reference image). */
export const ACTOR_CLIP_SECONDS_WITH_REFERENCE = ACTOR_CLIP_SECONDS_WITH_PRODUCT;

export function actorClipSeconds(hasReferenceImage: boolean): readonly number[] {
  return hasReferenceImage ? ACTOR_CLIP_SECONDS_WITH_REFERENCE : ACTOR_CLIP_SECONDS;
}

/**
 * 21.4a: actor clips will carry a reference image (so must be 8 s) when the owner chose a product
 * photo or an image generator can make the actor portrait. If the portrait later turns out to be
 * unavailable, 8 s is still a length Veo renders without references.
 */
export function ugcUsesReferenceImage(
  productImageId: string | null,
  registry: Pick<ProviderRegistry, 'getAdaptersByCapability'>,
): boolean {
  return Boolean(productImageId) || registry.getAdaptersByCapability('text_to_image').length > 0;
}

/**
 * Actor clips a UGC video may buy: about one per 10 s on STANDARD and one per 7.5 s on PLUS /
 * ENTERPRISE (30 s: 3 and 4), never under 2 (hook + call to action), at most 8. Per-channel
 * subscriptions all map to STANDARD; a legacy BASIC organisation gets the STANDARD rate.
 */
export const SECONDS_PER_ACTOR_CLIP: Readonly<Record<PlanTier, number>> = {
  BASIC: 10,
  STANDARD: 10,
  PLUS: 7.5,
  ENTERPRISE: 7.5,
};
export const MIN_ACTOR_CLIPS = 2;
export const MAX_ACTOR_CLIPS = 8;

export function actorClipBudget(tier: PlanTier, durationSec: number): number {
  const rate = SECONDS_PER_ACTOR_CLIP[tier];
  const n = Math.round(Math.max(0, durationSec) / rate);
  return Math.min(MAX_ACTOR_CLIPS, Math.max(MIN_ACTOR_CLIPS, n));
}

/**
 * The one B-roll treatment of a UGC video (21.4b): a product still, the product being used, shot
 * like a phone photo (generate-asset.ts ugcStill: the owner's product photo, the business's
 * library, else a generated image). Fastlane's UGC videos (2026-10-05) show product footage
 * between actor shots and never a title card or motion-graphics card, so UGC scripts get neither.
 */
export const UGC_BROLL_TREATMENT: VisualTreatment = 'IMAGE_STILL';
/** B-roll between two actor shots lasts 2–3 s (one caption's worth, no dead air). */
export const UGC_BROLL_SECONDS: readonly [number, number] = [2, 3];
/**
 * Wider B-roll limits used only when 2–3 s B-roll cannot fill the video next to its actor clips
 * (e.g. 4–6 s clips without a reference image): first up to 5 s, then the general 1–10 s, so the
 * script still lasts its target and passes the ±2 s duration check.
 */
const UGC_BROLL_FALLBACK_SECONDS: ReadonlyArray<readonly [number, number]> = [
  [2, 5],
  [1, 10],
];

/**
 * Treatments a UGC script may use: actors when a provider can make them, then product B-roll.
 * The product still is always offered (the owner's product photo and the business's library need
 * no provider), and TEXT_CARD / MOTION_GRAPHICS never are (21.4b).
 */
export function ugcTreatments(
  registry: Pick<ProviderRegistry, 'getAdaptersByCapability'>,
): VisualTreatment[] {
  const actors = registry.getAdaptersByCapability('actor_video').length > 0;
  return [...(actors ? (['UGC_ACTOR'] as const) : []), UGC_BROLL_TREATMENT];
}

function wordCount(text: string | null): number {
  return (text ?? '').split(/\s+/).filter(Boolean).length;
}

/** 21.4b: a card or any other non-actor shot of a UGC script becomes product B-roll. */
function asBroll(shot: PlannedShot): PlannedShot {
  return shot.visualTreatment === UGC_BROLL_TREATMENT
    ? shot
    : { ...shot, visualTreatment: UGC_BROLL_TREATMENT };
}

/** The shortest allowed clip that holds the line (and is at least what the script asked for). */
export function actorClipLength(
  shot: Pick<PlannedShot, 'durationSec' | 'voiceoverText'>,
  allowed: readonly number[],
): number {
  const needed = Math.max(
    shot.durationSec,
    wordCount(shot.voiceoverText) / ACTOR_WORDS_PER_SEC + ACTOR_LINE_PADDING_SEC,
  );
  const sorted = [...allowed].sort((a, b) => a - b);
  return sorted.find((s) => s >= needed - 0.25) ?? (sorted.at(-1) as number);
}

/**
 * The shot's words as one short on-screen line (when a shot cannot speak its line). 21.4b: B-roll
 * carries at most one short line in the native caption look, never a paragraph.
 */
function onScreen(shot: PlannedShot): string | null {
  return oneShortLine(shot.onScreenText) ?? oneShortLine(shot.voiceoverText);
}

function silenced(shot: PlannedShot): PlannedShot {
  return { ...shot, voiceoverText: null, onScreenText: onScreen(shot) };
}

function toProductStill(shot: PlannedShot, budget: number): PlannedShot {
  const routing =
    shot.providerRouting &&
    typeof shot.providerRouting === 'object' &&
    !Array.isArray(shot.providerRouting)
      ? (shot.providerRouting as Record<string, unknown>)
      : {};
  return silenced({
    ...shot,
    visualTreatment: BUDGET_TREATMENT,
    durationSec: Math.min(UGC_BROLL_SECONDS[1], Math.max(UGC_BROLL_SECONDS[0], shot.durationSec)),
    providerRouting: {
      ...routing,
      [CLIP_BUDGET_KEY]: { convertedFrom: 'UGC_ACTOR', budget },
    },
  });
}

const total = (shots: PlannedShot[]) => shots.reduce((t, s) => t + s.durationSec, 0);

/**
 * Actor clips keep their exact length; B-roll takes the rest of the target at 2–3 s a shot, or,
 * only when that cannot reach the target, the wider fallback limits (UGC_BROLL_FALLBACK_SECONDS).
 */
export function fitUgcDurations(shots: PlannedShot[], targetSec: number): PlannedShot[] {
  const fit = (broll: readonly [number, number]) =>
    fitDurations(shots, targetSec, (shot) =>
      shot.visualTreatment === 'UGC_ACTOR' ? [shot.durationSec, shot.durationSec] : [...broll],
    );
  let fitted = fit(UGC_BROLL_SECONDS);
  for (const wider of UGC_BROLL_FALLBACK_SECONDS) {
    if (Math.abs(total(fitted) - targetSec) < 0.05) break;
    fitted = fit(wider);
  }
  return fitted;
}

export interface UgcPlanResult {
  plan: PlannedScript;
  actorShots: number;
  converted: number;
}

/** Make a parsed UGC script executable (see the module comment). */
export function applyUgcPlan(
  plan: PlannedScript,
  input: { budget: number; targetSec: number; clipSeconds: readonly number[] },
): UgcPlanResult {
  const count = plan.shots.length;
  // Keep the hook, the call to action, then actor shots in order, up to the budget.
  const actorIndexes = plan.shots.flatMap((s, i) => (s.visualTreatment === 'UGC_ACTOR' ? [i] : []));
  const rank = (i: number) => {
    const beat = beatOf(i, count, plan.beats?.[i] ?? null);
    return beat === 'hook' ? 0 : beat === 'cta' ? 1 : 2;
  };
  // The kept clips must also fit inside the video (three 8 s clips fill a 30 s short; a fourth
  // would push it past the ±2 s duration check).
  const kept = new Set<number>();
  let actorSec = 0;
  for (const i of [...actorIndexes].sort((a, b) => rank(a) - rank(b) || a - b)) {
    const source = plan.shots[i];
    if (!source?.voiceoverText || kept.size >= Math.max(0, input.budget)) continue;
    const length = actorClipLength(source, input.clipSeconds);
    if (actorSec + length > input.targetSec) continue;
    kept.add(i);
    actorSec += length;
  }
  let converted = 0;
  const shots = plan.shots.map((shot, i) => {
    if (shot.visualTreatment !== 'UGC_ACTOR') return silenced(asBroll(shot));
    if (!kept.has(i) || !shot.voiceoverText) {
      converted += 1;
      return toProductStill(shot, input.budget);
    }
    return { ...shot, durationSec: actorClipLength(shot, input.clipSeconds) };
  });
  const fitted = fitUgcDurations(shots, input.targetSec);
  return {
    plan: { ...plan, shots: fitted },
    actorShots: fitted.filter((s) => s.visualTreatment === 'UGC_ACTOR').length,
    converted,
  };
}
