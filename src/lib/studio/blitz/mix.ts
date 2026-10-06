import { z } from 'zod';
import { FORMATS, isFormatKey, type FormatKey } from './formats';

// 22.4 — the content mix: owner-set weights plus BOUNDED nudges from swipes. A skip reason
// moves one weight a little (and says so: "You'll see fewer carousels"); a keep moves it back a
// little; "make more like this" (weekly insight) moves it up. Every nudge is capped at
// ±MAX_NUDGE from what the owner set, and a format the owner set to 0 (the paid formats by
// default) is never nudged above 0 — only the owner can turn a paid format on.

export const MAX_NUDGE = 20;
export const MIN_ANGLE_WEIGHT = 5;
export const MAX_WEIGHT = 100;

export const SKIP_REASONS = ['not_my_style', 'wrong_topic', 'too_salesy', 'seen_it'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** How far each signal moves a weight. */
export const NUDGE = {
  notMyStyle: -5,
  wrongTopic: -10,
  tooSalesy: -10,
  seenIt: -5,
  keepFormat: 2,
  keepAngle: 3,
  moreLikeThis: 10,
} as const;

export const adjustmentsSchema = z.object({
  formats: z.record(z.string(), z.number()).default({}),
  angles: z.record(z.string(), z.number()).default({}),
  mention: z.number().default(0),
});
export type MixAdjustments = z.infer<typeof adjustmentsSchema>;

export const EMPTY_ADJUSTMENTS: MixAdjustments = { formats: {}, angles: {}, mention: 0 };

export function readAdjustments(value: unknown): MixAdjustments {
  const parsed = adjustmentsSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : EMPTY_ADJUSTMENTS;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const bounded = (delta: number) => clamp(delta, -MAX_NUDGE, MAX_NUDGE);

export interface MixPreferences {
  formatWeights: Partial<Record<FormatKey, number>>;
  remixPercent: number;
  mentionBusinessPercent: number;
  captionStyleWeights: Record<string, number> | null;
  creatorChance: number;
  adjustments: MixAdjustments;
}

/** The weight a format is picked with: 0 stays 0; otherwise owner weight + nudge, 1–100. */
export function effectiveFormatWeight(prefs: MixPreferences, key: FormatKey): number {
  const base = prefs.formatWeights[key] ?? 0;
  if (base <= 0) return 0;
  return clamp(base + (prefs.adjustments.formats[key] ?? 0), 1, MAX_WEIGHT);
}

export function effectiveAngleWeight(
  adjustments: MixAdjustments,
  angle: { id: string; weight: number },
): number {
  if (angle.weight <= 0) return 0;
  return clamp(angle.weight + (adjustments.angles[angle.id] ?? 0), MIN_ANGLE_WEIGHT, MAX_WEIGHT);
}

export function effectiveMentionPercent(prefs: MixPreferences): number {
  return clamp(prefs.mentionBusinessPercent + prefs.adjustments.mention, 0, 100);
}

/** Weighted pick; `rand` in [0, 1). Null when every weight is 0. */
export function pickWeighted<K>(
  entries: ReadonlyArray<readonly [K, number]>,
  rand: number,
): K | null {
  const live = entries.filter(([, w]) => w > 0);
  const total = live.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) return null;
  let at = Math.min(Math.max(rand, 0), 0.999_999) * total;
  for (const [key, weight] of live) {
    if (at < weight) return key;
    at -= weight;
  }
  return live[live.length - 1]![0];
}

export function pickFormat(
  prefs: MixPreferences,
  available: readonly FormatKey[],
  rand: number,
): FormatKey | null {
  return pickWeighted(
    available.map((key) => [key, effectiveFormatWeight(prefs, key)] as const),
    rand,
  );
}

/** What the person is told after a skip reason ("You'll see fewer X"). */
export type NudgeNotice =
  | { kind: 'fewer_format'; format: FormatKey }
  | { kind: 'fewer_angle'; angleTitle: string }
  | { kind: 'less_salesy' }
  | { kind: 'at_limit' };

export interface SwipeSignal {
  action: 'keep' | 'skip' | 'more_like_this';
  reason?: SkipReason;
  format: FormatKey;
  angle?: { id: string; title: string } | null;
}

/**
 * The nudged adjustments for one swipe, and what to tell the person. Pure: the caller stores the
 * result. A nudge that is already at its bound changes nothing and says so (`at_limit`).
 */
export function applySignal(
  prefs: Pick<MixPreferences, 'formatWeights' | 'adjustments'>,
  signal: SwipeSignal,
): { adjustments: MixAdjustments; notice: NudgeNotice | null } {
  const current = prefs.adjustments;
  const formats = { ...current.formats };
  const angles = { ...current.angles };
  let mention = current.mention;
  const moveFormat = (delta: number) => {
    // A format the owner set to 0 is never nudged (paid formats stay off).
    if ((prefs.formatWeights[signal.format] ?? 0) <= 0) return false;
    const before = formats[signal.format] ?? 0;
    formats[signal.format] = bounded(before + delta);
    return formats[signal.format] !== before;
  };
  const moveAngle = (delta: number) => {
    if (!signal.angle) return false;
    const before = angles[signal.angle.id] ?? 0;
    angles[signal.angle.id] = bounded(before + delta);
    return angles[signal.angle.id] !== before;
  };
  let notice: NudgeNotice | null = null;
  if (signal.action === 'keep') {
    moveFormat(NUDGE.keepFormat);
    moveAngle(NUDGE.keepAngle);
  } else if (signal.action === 'more_like_this') {
    moveFormat(NUDGE.moreLikeThis);
    moveAngle(NUDGE.moreLikeThis);
  } else {
    switch (signal.reason) {
      case 'not_my_style':
        notice = moveFormat(NUDGE.notMyStyle)
          ? { kind: 'fewer_format', format: signal.format }
          : { kind: 'at_limit' };
        break;
      case 'wrong_topic':
      case 'seen_it': {
        const moved = moveAngle(signal.reason === 'wrong_topic' ? NUDGE.wrongTopic : NUDGE.seenIt);
        notice =
          moved && signal.angle
            ? { kind: 'fewer_angle', angleTitle: signal.angle.title }
            : { kind: 'at_limit' };
        break;
      }
      case 'too_salesy': {
        const before = mention;
        mention = bounded(mention + NUDGE.tooSalesy);
        notice = mention !== before ? { kind: 'less_salesy' } : { kind: 'at_limit' };
        break;
      }
      default:
        notice = null;
    }
  }
  return { adjustments: { formats, angles, mention }, notice };
}

/** Owner weights from stored JSON: only known formats, integers 0–100. */
export function readFormatWeights(value: unknown): Partial<Record<FormatKey, number>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Partial<Record<FormatKey, number>> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isFormatKey(key) || typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    out[key] = clamp(Math.round(raw), 0, MAX_WEIGHT);
  }
  return out;
}

/** Explainable list of the nudges in force (for the "Content mix" panel). */
export function describeAdjustments(
  adjustments: MixAdjustments,
): Array<{ target: 'format' | 'angle' | 'mention'; id: string; delta: number }> {
  return [
    ...Object.entries(adjustments.formats)
      .filter(([key, d]) => d !== 0 && key in FORMATS)
      .map(([id, delta]) => ({ target: 'format' as const, id, delta })),
    ...Object.entries(adjustments.angles)
      .filter(([, d]) => d !== 0)
      .map(([id, delta]) => ({ target: 'angle' as const, id, delta })),
    ...(adjustments.mention !== 0
      ? [{ target: 'mention' as const, id: 'mention', delta: adjustments.mention }]
      : []),
  ];
}
