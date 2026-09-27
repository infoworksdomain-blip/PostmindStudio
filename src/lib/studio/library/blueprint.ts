import type { VideoLibraryAnalysis, VisualTreatment } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, ProviderError } from '../../errors';
import type { PlannedScript } from '../pipeline/scripting';
import { OVERLAY_STYLES, SHOT_TYPES, type ShotType } from './analyse';

// BACKLOG 9.5 / Addendum A3.6–A3.7 — reference-guided generation.
// TEMPLATE: the reference's structural blueprint (shot count, per-shot durations and roles,
// overlay styles, transitions, music envelope) constrains Layer 2; content is new.
// INSPIRE: only a style signature (pace, mood, structure, music genre) supplements Layers 1–2.
// No bytes of the reference are ever used (A3.10).

const storedShot = z.object({
  startSec: z.number(),
  endSec: z.number(),
  type: z.enum(SHOT_TYPES),
  description: z.string().default(''),
  onScreenText: z.string().default(''),
  overlayStyle: z.enum(OVERLAY_STYLES).default('none'),
  voiceoverPresent: z.boolean().default(false),
});

const musicEnvelope = z
  .object({
    bpm: z.number().nullable().optional(),
    energy: z.string().optional(),
    mood: z.string().optional(),
    genre: z.string().optional(),
  })
  .passthrough();

export interface BlueprintShot {
  durationSec: number;
  type: ShotType;
  overlayStyle: (typeof OVERLAY_STYLES)[number];
  voiceoverPresent: boolean;
  hasOnScreenText: boolean;
}

export interface Blueprint {
  shotCount: number;
  totalDurationSec: number;
  shots: BlueprintShot[];
  musicEnvelope: { bpm: number | null; energy: string | null; moodTag: string | null };
  transitionSequence: string[];
  hookPattern: string;
  structurePattern: string;
  ctaPattern: string | null;
  paceTag: string;
}

export interface StyleSignature {
  paceTag: string;
  moodTag: string;
  structurePattern: string;
  musicGenreTag: string | null;
}

export function buildBlueprint(analysis: VideoLibraryAnalysis): Blueprint {
  const shots = z.array(storedShot).parse(analysis.shots);
  const music = musicEnvelope.safeParse(analysis.musicEnvelope);
  const blueprintShots = shots.map((s) => ({
    durationSec: Math.round((s.endSec - s.startSec) * 100) / 100,
    type: s.type,
    overlayStyle: s.overlayStyle,
    voiceoverPresent: s.voiceoverPresent,
    hasOnScreenText: s.onScreenText.length > 0,
  }));
  return {
    shotCount: blueprintShots.length,
    totalDurationSec: Math.round(blueprintShots.reduce((t, s) => t + s.durationSec, 0) * 100) / 100,
    shots: blueprintShots,
    musicEnvelope: {
      bpm: music.success ? (music.data.bpm ?? null) : null,
      energy: music.success ? (music.data.energy ?? null) : null,
      moodTag: music.success ? (music.data.mood ?? null) : null,
    },
    // Scene detection finds hard changes only; dissolves/whooshes are not classified yet.
    transitionSequence: blueprintShots.map(() => 'cut'),
    hookPattern: analysis.hookPattern,
    structurePattern: analysis.structurePattern,
    ctaPattern: analysis.ctaPattern,
    paceTag: analysis.paceTag,
  };
}

export function styleSignature(analysis: VideoLibraryAnalysis): StyleSignature {
  const music = musicEnvelope.safeParse(analysis.musicEnvelope);
  return {
    paceTag: analysis.paceTag,
    moodTag: analysis.moodTag,
    structurePattern: analysis.structurePattern,
    musicGenreTag: music.success ? (music.data.mood ?? music.data.genre ?? null) : null,
  };
}

/** Shot role → the treatment Layer 2 should use, limited to what's available. */
const TREATMENT_FOR: Record<ShotType, VisualTreatment[]> = {
  HOOK_TEXT_ON_STILL: ['IMAGE_STILL', 'TEXT_CARD'],
  TALKING_HEAD: ['AI_AVATAR', 'AI_CLIP'],
  AVATAR_TALKING: ['AI_AVATAR', 'AI_CLIP'],
  AI_CLIP_ACTION: ['AI_CLIP', 'STOCK_FOOTAGE'],
  PRODUCT_SHOT: ['AI_CLIP', 'IMAGE_STILL'],
  STOCK_LIFESTYLE: ['STOCK_FOOTAGE', 'AI_CLIP'],
  SCREEN_RECORDING: ['MOTION_GRAPHICS', 'TEXT_CARD'],
  B_ROLL: ['AI_CLIP', 'STOCK_FOOTAGE'],
  TEXT_CARD: ['TEXT_CARD'],
  CTA_CARD: ['TEXT_CARD'],
};

export function treatmentFor(type: ShotType, available: VisualTreatment[]): VisualTreatment {
  return TREATMENT_FOR[type].find((t) => available.includes(t)) ?? available[0] ?? 'TEXT_CARD';
}

/** Blueprint durations scaled to the target format duration (A3.6 "same duration budget"). */
export function scaledDurations(blueprint: Blueprint, targetSec: number): number[] {
  const scale = targetSec / blueprint.totalDurationSec;
  const raw = blueprint.shots.map((s) => Math.max(1, Math.round(s.durationSec * scale * 10) / 10));
  const drift = Math.round((targetSec - raw.reduce((a, b) => a + b, 0)) * 10) / 10;
  const longest = raw.indexOf(Math.max(...raw));
  if (longest >= 0) raw[longest] = Math.max(1, Math.round(((raw[longest] ?? 1) + drift) * 10) / 10);
  return raw;
}

/** Layer 2 prompt supplement for TEMPLATE mode. */
export function templateConstraint(
  blueprint: Blueprint,
  targetSec: number,
  available: VisualTreatment[],
): string {
  const durations = scaledDurations(blueprint, targetSec);
  const lines = blueprint.shots.map(
    (s, i) =>
      `${i + 1}. ${durations[i]}s, ${treatmentFor(s.type, available)} (${s.type.toLowerCase().replace(/_/g, ' ')})` +
      `${s.voiceoverPresent ? ', voiceover' : ', no voiceover'}${s.hasOnScreenText ? ', on-screen text' : ''}`,
  );
  return [
    'STRUCTURE TEMPLATE (follow exactly; write entirely new content for this brand):',
    `Exactly ${blueprint.shotCount} shots, in this order, with these durations and treatments:`,
    ...lines,
    `Hook pattern: ${blueprint.hookPattern}. Structure: ${blueprint.structurePattern}.`,
    blueprint.ctaPattern ? `Call-to-action pattern: ${blueprint.ctaPattern}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Layers 1–2 prompt supplement for INSPIRE mode (A3.7). */
export function inspireSupplement(style: StyleSignature): string {
  return (
    `Generate in this style: ${style.paceTag} pacing, ${style.moodTag} mood, ` +
    `${style.structurePattern} structure${style.musicGenreTag ? `, ${style.musicGenreTag} music vibe` : ''}.`
  );
}

/**
 * Enforce the template on Layer 2's output: same shot count, the blueprint's durations and
 * transitions. A different shot count is a retryable model error.
 */
export function applyTemplate(
  plan: PlannedScript,
  blueprint: Blueprint,
  targetSec: number,
): PlannedScript {
  if (plan.shots.length !== blueprint.shotCount) {
    throw new ProviderError(
      'text_generation',
      'unknown',
      `Template needs ${blueprint.shotCount} shots; script has ${plan.shots.length}`,
      true,
    );
  }
  const durations = scaledDurations(blueprint, targetSec);
  return {
    ...plan,
    shots: plan.shots.map((shot, i) => ({
      ...shot,
      durationSec: durations[i] ?? shot.durationSec,
      transitionOut: blueprint.transitionSequence[i] ?? shot.transitionOut,
    })),
  };
}

/** A3.1 / A3.2 licence gate: TEMPLATE needs a licence row that allows it. */
export function assertModeAllowed(
  mode: 'TEMPLATE' | 'INSPIRE',
  license: { allowedModes: string[]; licenseExpires: Date | null } | null,
  now: number,
): void {
  if (!license) throw new ConflictError('This library video has no licence record');
  if (license.licenseExpires && license.licenseExpires.getTime() < now)
    throw new ConflictError('This library video’s licence has expired');
  if (!license.allowedModes.includes(mode))
    throw new ConflictError(`${mode} mode is not allowed for this library video`);
}

/** Overlay style in the reference → the Phase 8 preset key used for suggestions. */
export const OVERLAY_STYLE_PRESET: Record<(typeof OVERLAY_STYLES)[number], string | null> = {
  none: null,
  'bold-centre': 'hook_bold_centre',
  'bold-top': 'hook_bold_centre',
  'bold-bottom': 'cta_big_arrow',
  'subtitle-lower': 'subtitle_clean_lower',
  'caption-box': 'subtitle_box',
  quote: 'quote_modern',
  'big-number': 'stat_big_number',
};
