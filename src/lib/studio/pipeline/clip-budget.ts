import type { VisualTreatment } from '@prisma/client';
import type { VideoResolution } from '../providers/interface';
import type { PlanTier } from '../providers/router';
import {
  fitDurations,
  shotDurationBounds,
  type DurationBounds,
  type PlannedScript,
  type PlannedShot,
  type ShotBeat,
} from './scripting';

// BACKLOG 20.25 (operator decision 2026-10-03) — cheaper videos without changing prices or
// allowances. AI clips are the biggest provider cost of a video (QA run 3: 8 Veo clips were £2.40
// of £3.33), so Layer 2 gets an AI clip budget per plan tier and video length:
//   - the script prompt states the budget (scripting.ts clipBudgetLine);
//   - after parsing, extra AI_CLIP / AI_AVATAR shots are converted to IMAGE_STILL shots marked
//     `providerRouting.clipBudget`. Layer 3 gives those the business's own image, then a stock
//     image, then a composer-rendered motion-graphics (or text) card — never a paid generation
//     (generate-asset.ts budgetStill);
//   - the AI clips kept are the hook, the call to action, the key demo, then the others spread
//     across the video;
//   - AI_CLIP shots are kept to AI_CLIP_MAX_SEC (the providers' minimum clip lengths are 3–4 s,
//     so a longer shot only adds paid seconds) unless the script cannot fill its length otherwise;
//   - BASIC clips rendered at 480p where the provider offered it (Seedance), the other tiers at
//     720p; since 21.3 every tier is 720p HD on the full Seedance 2.0.

/** Roughly one AI clip per this many seconds of video (30 s: BASIC 3, STANDARD 4, PLUS 6). */
export const SECONDS_PER_AI_CLIP: Readonly<Record<PlanTier, number>> = {
  BASIC: 10,
  STANDARD: 7,
  PLUS: 5,
  ENTERPRISE: 5,
};
/**
 * Past the first minute (long-form videos), at most one AI clip per this many seconds on any tier,
 * so a 3- or 6-minute video stays within the catalogue's typical long-form cost.
 */
export const LONG_FORM_SECONDS_PER_AI_CLIP = 8;
export const FULL_RATE_SEC = 60;
/** Every video may open and close on an AI clip, however short. */
export const MIN_AI_CLIPS = 2;
/** The longest AI_CLIP shot the budget keeps (Seedance and Veo bill at least 4 s, Kling 3 s). */
export const AI_CLIP_MAX_SEC = 4;
/**
 * The resolution AI clips are requested at. 21.3 (operator decision 2026-10-04, one per-channel
 * subscription with HD video): 720p on every tier (BASIC's 480p from 20.25 is dropped). Only
 * Seedance reads it; Kling and Veo use their own configured resolution (720p by default). 1080p
 * stays reachable through STUDIO_SEEDANCE_RESOLUTION (providers/seedance.ts), which no plan sets.
 */
export const AI_CLIP_RESOLUTION: Readonly<Record<PlanTier, VideoResolution>> = {
  BASIC: '720p',
  STANDARD: '720p',
  PLUS: '720p',
  ENTERPRISE: '720p',
};

const AI_TREATMENTS: ReadonlySet<VisualTreatment> = new Set<VisualTreatment>([
  'AI_CLIP',
  'AI_AVATAR',
]);

/** The treatment a converted shot gets; Layer 3 never pays for its image. */
export const BUDGET_TREATMENT: VisualTreatment = 'IMAGE_STILL';
export const CLIP_BUDGET_KEY = 'clipBudget';

export interface ClipBudgetRouting {
  convertedFrom: VisualTreatment;
  budget: number;
}

export function isAiShot(treatment: VisualTreatment): boolean {
  return AI_TREATMENTS.has(treatment);
}

/**
 * The most AI_CLIP + AI_AVATAR shots a script of this length may use on this tier: the tier's rate
 * for the first minute, then at most one per LONG_FORM_SECONDS_PER_AI_CLIP; never under two.
 */
export function aiClipBudget(tier: PlanTier, durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return MIN_AI_CLIPS;
  const rate = SECONDS_PER_AI_CLIP[tier];
  const first = Math.min(durationSec, FULL_RATE_SEC) / rate;
  const rest =
    Math.max(0, durationSec - FULL_RATE_SEC) / Math.max(rate, LONG_FORM_SECONDS_PER_AI_CLIP);
  return Math.max(MIN_AI_CLIPS, Math.round(first + rest));
}

export function aiClipResolution(tier: PlanTier): VideoResolution {
  return AI_CLIP_RESOLUTION[tier];
}

/** The clip-budget marker on a shot's providerRouting, or null for an ordinary shot. */
export function clipBudgetOf(providerRouting: unknown): ClipBudgetRouting | null {
  if (!providerRouting || typeof providerRouting !== 'object' || Array.isArray(providerRouting))
    return null;
  const value = (providerRouting as Record<string, unknown>)[CLIP_BUDGET_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { convertedFrom, budget } = value as Record<string, unknown>;
  if (typeof convertedFrom !== 'string' || typeof budget !== 'number') return null;
  return { convertedFrom: convertedFrom as VisualTreatment, budget };
}

const BEAT_RANK: Readonly<Record<ShotBeat, number>> = { hook: 0, cta: 1, demo: 2, other: 3 };

/** The model's beat, else the position: first shot = hook, last shot = call to action. */
export function beatOf(index: number, count: number, declared: ShotBeat | null = null): ShotBeat {
  if (declared && declared !== 'other') return declared;
  if (index === 0) return 'hook';
  if (count > 1 && index === count - 1) return 'cta';
  return 'other';
}

/**
 * The AI shots (by index) the budget keeps: by beat (hook, call to action, demo, other) and,
 * within a beat, the shot farthest from the ones already kept, so the clips spread over the video.
 */
export function keptAiShots(
  shots: readonly PlannedShot[],
  beats: ReadonlyArray<ShotBeat | null> | undefined,
  budget: number,
): Set<number> {
  const candidates = shots.flatMap((shot, index) =>
    isAiShot(shot.visualTreatment)
      ? [{ index, rank: BEAT_RANK[beatOf(index, shots.length, beats?.[index] ?? null)] }]
      : [],
  );
  const kept = new Set<number>();
  const distance = (index: number) =>
    kept.size === 0 ? 0 : Math.min(...[...kept].map((k) => Math.abs(k - index)));
  while (kept.size < Math.max(0, budget) && kept.size < candidates.length) {
    const next = candidates
      .filter((c) => !kept.has(c.index))
      .sort(
        (a, b) => a.rank - b.rank || distance(b.index) - distance(a.index) || a.index - b.index,
      )[0];
    if (!next) break;
    kept.add(next.index);
  }
  return kept;
}

function convert(shot: PlannedShot, budget: number): PlannedShot {
  const marker: ClipBudgetRouting = { convertedFrom: shot.visualTreatment, budget };
  const routing =
    shot.providerRouting &&
    typeof shot.providerRouting === 'object' &&
    !Array.isArray(shot.providerRouting)
      ? (shot.providerRouting as Record<string, unknown>)
      : {};
  const [min, max] = shotDurationBounds(BUDGET_TREATMENT);
  return {
    ...shot,
    visualTreatment: BUDGET_TREATMENT,
    durationSec: Math.min(max, Math.max(min, shot.durationSec)),
    providerRouting: { ...routing, [CLIP_BUDGET_KEY]: { ...marker } },
  };
}

/** AI clips at most AI_CLIP_MAX_SEC; avatar shots keep their length (they follow the narration). */
const budgetBounds: DurationBounds = (shot) => {
  const [min, max] = shotDurationBounds(shot.visualTreatment);
  if (shot.visualTreatment === 'AI_CLIP') return [min, Math.min(max, AI_CLIP_MAX_SEC)];
  if (shot.visualTreatment === 'AI_AVATAR') return [shot.durationSec, shot.durationSec];
  return [min, max];
};

function totalSec(shots: readonly PlannedShot[]): number {
  return shots.reduce((sum, s) => sum + s.durationSec, 0);
}

/**
 * AI_CLIP shots shortened to AI_CLIP_MAX_SEC, the other shots taking up the time. When the other
 * shots cannot absorb it (a script of nothing but AI clips), the ordinary bounds are used.
 */
export function capAiClipDurations(shots: PlannedShot[], targetSec: number): PlannedShot[] {
  const isClip = (s: PlannedShot) => s.visualTreatment === 'AI_CLIP';
  if (!shots.some((s) => isClip(s) && s.durationSec > AI_CLIP_MAX_SEC)) return shots;
  const capped = shots.map((s) =>
    isClip(s) ? { ...s, durationSec: Math.min(s.durationSec, AI_CLIP_MAX_SEC) } : s,
  );
  // The freed seconds go to the cheaper (non-AI) shots in proportion to their length, then the
  // usual fit clamps to each treatment's bounds and settles the rounding.
  const takes = (s: PlannedShot) => !isAiShot(s.visualTreatment);
  const freed = totalSec(shots) - totalSec(capped);
  const othersSec = totalSec(capped.filter(takes));
  const grown =
    othersSec > 0
      ? capped.map((s) =>
          takes(s) ? { ...s, durationSec: s.durationSec + (freed * s.durationSec) / othersSec } : s,
        )
      : capped;
  const fitted = fitDurations(grown, targetSec, budgetBounds);
  return Math.abs(totalSec(fitted) - targetSec) < 0.05 ? fitted : fitDurations(shots, targetSec);
}

export interface ClipBudgetResult {
  plan: PlannedScript;
  /** AI shots converted to budget stills. */
  converted: number;
  /** AI shots kept. */
  aiShots: number;
}

/**
 * Enforce the AI clip budget on a parsed script (after any TEMPLATE re-timing). `keepDurations`
 * leaves the shot lengths alone (a TEMPLATE reference fixes them).
 */
export function applyClipBudget(
  plan: PlannedScript,
  input: { budget: number; targetSec: number; keepDurations?: boolean },
): ClipBudgetResult {
  const kept = keptAiShots(plan.shots, plan.beats, input.budget);
  let converted = 0;
  const shots = plan.shots.map((shot, index) => {
    if (!isAiShot(shot.visualTreatment) || kept.has(index)) return shot;
    converted += 1;
    return convert(shot, input.budget);
  });
  const timed = input.keepDurations ? shots : capAiClipDurations(shots, input.targetSec);
  return { plan: { ...plan, shots: timed }, converted, aiShots: kept.size };
}
