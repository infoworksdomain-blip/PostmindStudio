import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  availableFormats,
  defaultFormatWeights,
  FORMAT_KEYS,
  type FormatKey,
} from '../blitz/formats';
import {
  applySignal,
  describeAdjustments,
  EMPTY_ADJUSTMENTS,
  effectiveFormatWeight,
  effectiveMentionPercent,
  readAdjustments,
  readFormatWeights,
  type MixPreferences,
  type NudgeNotice,
  type SwipeSignal,
} from '../blitz/mix';
import { ValidationError } from '../../errors';
import { BUILT_IN_PRESETS } from '../overlays/presets';
import type { BusinessScope } from './angles';

// 22.4 — the business's content-mix preferences (Fastlane "content mix": type weights, remix %,
// mention-business %, caption-style weights, influencer chance). Automations snapshot them at
// activation. Absent row = the defaults (formats from blitz/formats.ts, paid formats at 0).

export const DEFAULT_REMIX_PERCENT = 20;
export const DEFAULT_MENTION_PERCENT = 30;

const percent = z.number().int().min(0).max(100);

export const mixInput = z
  .object({
    formatWeights: z.partialRecord(z.enum(FORMAT_KEYS), percent).optional(),
    remixPercent: percent.optional(),
    mentionBusinessPercent: percent.optional(),
    captionStyleWeights: z.record(z.string().trim().min(1).max(64), percent).nullable().optional(),
    creatorChance: percent.optional(),
    /** Clear the swipe nudges (back to exactly what the owner set). */
    resetAdjustments: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

type Db = Pick<PrismaClient, 'contentMixPreference'>;

export function defaultMix(): MixPreferences {
  return {
    formatWeights: defaultFormatWeights(),
    remixPercent: DEFAULT_REMIX_PERCENT,
    mentionBusinessPercent: DEFAULT_MENTION_PERCENT,
    captionStyleWeights: null,
    creatorChance: 0,
    adjustments: EMPTY_ADJUSTMENTS,
  };
}

function readCaptionWeights(value: Prisma.JsonValue | null): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === 'number') out[k] = v;
  return out;
}

export async function getMix(db: Db, scope: BusinessScope): Promise<MixPreferences> {
  const row = await db.contentMixPreference.findUnique({
    where: { organisationId_businessId: scope },
  });
  if (!row) return defaultMix();
  return {
    // Formats the stored row never mentioned (one that became available later) take the default.
    formatWeights: { ...defaultFormatWeights(), ...readFormatWeights(row.formatWeights) },
    remixPercent: row.remixPercent,
    mentionBusinessPercent: row.mentionBusinessPercent,
    captionStyleWeights: readCaptionWeights(row.captionStyleWeights),
    creatorChance: row.creatorChance,
    adjustments: readAdjustments(row.adjustments),
  };
}

async function writeMix(db: Db, scope: BusinessScope, userId: string, mix: MixPreferences) {
  const data = {
    formatWeights: mix.formatWeights as Prisma.InputJsonValue,
    remixPercent: mix.remixPercent,
    mentionBusinessPercent: mix.mentionBusinessPercent,
    captionStyleWeights: (mix.captionStyleWeights ?? undefined) as
      Prisma.InputJsonValue | undefined,
    creatorChance: mix.creatorChance,
    adjustments: mix.adjustments as unknown as Prisma.InputJsonValue,
    updatedByUserId: userId,
  };
  await db.contentMixPreference.upsert({
    where: { organisationId_businessId: scope },
    create: { ...scope, ...data },
    update: data,
  });
}

/** Caption-style weights only for presets that exist (21.4b adds the TikTok-classic ones). */
export function knownPresetWeights(
  weights: Record<string, number> | null,
): Record<string, number> | null {
  if (!weights) return null;
  const known = new Set(BUILT_IN_PRESETS.map((p) => p.key));
  const unknown = Object.keys(weights).filter((k) => !known.has(k));
  if (unknown.length)
    throw new ValidationError('Unknown caption style', { code: 'unknown_caption_style', unknown });
  return weights;
}

export async function putMix(
  db: Db,
  scope: BusinessScope,
  userId: string,
  input: z.infer<typeof mixInput>,
): Promise<MixPreferences> {
  const current = await getMix(db, scope);
  const next: MixPreferences = {
    formatWeights: { ...current.formatWeights, ...(input.formatWeights ?? {}) },
    remixPercent: input.remixPercent ?? current.remixPercent,
    mentionBusinessPercent: input.mentionBusinessPercent ?? current.mentionBusinessPercent,
    captionStyleWeights:
      input.captionStyleWeights === undefined
        ? current.captionStyleWeights
        : knownPresetWeights(input.captionStyleWeights),
    creatorChance: input.creatorChance ?? current.creatorChance,
    adjustments: input.resetAdjustments ? EMPTY_ADJUSTMENTS : current.adjustments,
  };
  await writeMix(db, scope, userId, next);
  return next;
}

/** Store the nudge of one swipe; returns what to tell the person. */
export async function recordSignal(
  db: Db,
  scope: BusinessScope,
  userId: string,
  signal: SwipeSignal,
): Promise<NudgeNotice | null> {
  const current = await getMix(db, scope);
  const { adjustments, notice } = applySignal(current, signal);
  await writeMix(db, scope, userId, { ...current, adjustments });
  return notice;
}

/** GET …/content-mix: owner weights, what is in force after nudges, and the nudges themselves. */
export function publicMix(
  mix: MixPreferences,
  available: readonly FormatKey[] = availableFormats(),
) {
  return {
    available,
    formatWeights: mix.formatWeights,
    effectiveFormatWeights: Object.fromEntries(
      available.map((key) => [key, effectiveFormatWeight(mix, key)]),
    ),
    remixPercent: mix.remixPercent,
    mentionBusinessPercent: mix.mentionBusinessPercent,
    effectiveMentionPercent: effectiveMentionPercent(mix),
    captionStyleWeights: mix.captionStyleWeights,
    creatorChance: mix.creatorChance,
    adjustments: describeAdjustments(mix.adjustments),
  };
}
