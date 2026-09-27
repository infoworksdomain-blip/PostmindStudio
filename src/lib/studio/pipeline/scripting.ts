import type { VisualTreatment } from '@prisma/client';
import { z } from 'zod';
import { ProviderError, ValidationError } from '../../errors';
import type { AspectRatio, ProviderCapability } from '../providers/interface';
import type { ProviderRegistry } from '../providers/registry';
import type { IdeationResult } from './ideation';

// Layer 2 — Script + storyboard (spec 5.3): one script per target format, broken into shots.
// The model may only use visual treatments Studio can actually produce right now (a treatment
// whose provider isn't configured would just fail later), and shot durations are normalised
// so each script sums exactly to its target duration (spec 13.1 checks ±2s).

export interface TargetFormat {
  platform: string;
  aspectRatio: AspectRatio;
  durationSec: number;
}

const ASPECT_RATIOS = ['9:16', '16:9', '1:1', '4:5'] as const;

const targetFormatSchema = z.object({
  platform: z.string().min(1),
  aspectRatio: z.enum(ASPECT_RATIOS),
  duration: z
    .number()
    .positive()
    .max(60 * 60),
});

/** video_projects.targetFormats = [{ platform, aspectRatio, duration }] (spec 7.3). */
export function parseTargetFormats(value: unknown): TargetFormat[] {
  const parsed = z.array(targetFormatSchema).min(1).safeParse(value);
  if (!parsed.success) throw new ValidationError('Project targetFormats are invalid or empty');
  return parsed.data.map((f) => ({
    platform: f.platform,
    aspectRatio: f.aspectRatio,
    durationSec: f.duration,
  }));
}

const TREATMENT_CAPABILITY: Partial<Record<VisualTreatment, ProviderCapability>> = {
  AI_CLIP: 'text_to_video',
  IMAGE_STILL: 'text_to_image',
  AI_AVATAR: 'avatar_video',
  STOCK_FOOTAGE: 'stock_footage',
};

/** Treatments usable now: provider-backed ones with a configured provider, plus TEXT_CARD. */
export function availableTreatments(registry: ProviderRegistry): VisualTreatment[] {
  const provided = (
    Object.entries(TREATMENT_CAPABILITY) as Array<[VisualTreatment, ProviderCapability]>
  )
    .filter(([, capability]) => registry.getAdaptersByCapability(capability).length > 0)
    .map(([treatment]) => treatment);
  return [...provided, 'TEXT_CARD'];
}

export const TRANSITIONS = ['cut', 'fade', 'wipe', 'slide', 'zoom'] as const;

/** Clip-length limits: AI clips 2–10s (Runway), everything else 1–10s. */
export function shotDurationBounds(treatment: VisualTreatment): [number, number] {
  return treatment === 'AI_CLIP' ? [2, 10] : [1, 10];
}

export function scriptSchema(treatments: VisualTreatment[]) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['fullText', 'shots'],
    properties: {
      fullText: { type: 'string', description: 'the complete voiceover as one passage' },
      shots: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'durationSec',
            'visualTreatment',
            'sceneDescription',
            'cameraDirection',
            'voiceoverText',
            'onScreenText',
            'transitionOut',
          ],
          properties: {
            durationSec: { type: 'number' },
            visualTreatment: { type: 'string', enum: treatments },
            sceneDescription: {
              type: 'string',
              description: 'visual prompt for the generator, no text in frame',
            },
            cameraDirection: { type: 'string' },
            voiceoverText: {
              type: 'string',
              description: 'words spoken during this shot, empty if none',
            },
            onScreenText: { type: 'string', description: 'short caption overlay, empty if none' },
            transitionOut: { type: 'string', enum: [...TRANSITIONS] },
          },
        },
      },
    },
  } as const;
}

const shotResult = z.object({
  durationSec: z.number().positive(),
  visualTreatment: z.string(),
  sceneDescription: z.string().min(1),
  cameraDirection: z.string(),
  voiceoverText: z.string(),
  onScreenText: z.string(),
  transitionOut: z.enum(TRANSITIONS),
});

const scriptResult = z.object({ fullText: z.string(), shots: z.array(shotResult).min(1).max(120) });

export interface PlannedShot {
  sortOrder: number;
  durationSec: number;
  visualTreatment: VisualTreatment;
  sceneDescription: string;
  cameraDirection: string | null;
  voiceoverText: string | null;
  onScreenText: string | null;
  transitionOut: string;
}

export interface PlannedScript {
  fullText: string;
  shots: PlannedShot[];
}

export const SCRIPT_SYSTEM_PROMPT = [
  'You are the script and storyboard layer of PostMind Studio.',
  'Write one script for the given platform and duration, split into shots that together last exactly the target duration.',
  'Open with the hook in the first shot. Keep one idea per shot. Speak naturally; roughly 2.5 spoken words per second.',
  'AI_CLIP shots must be 2–10 seconds; other shots 1–10 seconds.',
  "Scene descriptions are prompts for a video/image generator: describe subject, setting, light and motion; never ask for text, logos or real people's likenesses in frame.",
  'Only use the visual treatments offered. Never invent prices, statistics or claims absent from the brief.',
].join('\n');

export function buildScriptPrompt(input: {
  brief: IdeationResult;
  format: TargetFormat;
  treatments: VisualTreatment[];
  restrictedTopics: string[];
}): string {
  const { brief, format } = input;
  return [
    `Platform: ${format.platform} (${format.aspectRatio})`,
    `Target duration: ${format.durationSec} seconds`,
    `Visual treatments available: ${input.treatments.join(', ')}`,
    input.restrictedTopics.length ? `Never mention: ${input.restrictedTopics.join(', ')}` : '',
    '',
    `Hook: ${brief.hook}`,
    `Key message: ${brief.keyMessage}`,
    `Audience: ${brief.targetAudience}`,
    `Tone: ${brief.tone}`,
    brief.callToAction ? `Call to action: ${brief.callToAction}` : 'No call to action.',
    brief.keywords.length ? `Keywords: ${brief.keywords.join(', ')}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Validate model output and make it executable: unknown treatments are rejected, durations
 * clamped to provider limits and scaled so the script sums to the target (rounded to 0.1s,
 * with the remainder absorbed by the longest adjustable shot).
 */
export function normaliseScript(
  json: unknown,
  treatments: VisualTreatment[],
  targetSec: number,
): PlannedScript {
  const parsed = scriptResult.safeParse(json);
  if (!parsed.success) {
    throw new ProviderError('text_generation', 'unknown', 'Script output failed validation', true, {
      issues: parsed.error.issues.slice(0, 5).map((i) => i.message),
    });
  }
  const allowed = new Set<string>(treatments);
  const shots = parsed.data.shots.map((shot, index) => {
    if (!allowed.has(shot.visualTreatment)) {
      throw new ProviderError(
        'text_generation',
        'unknown',
        `Script used unavailable treatment ${shot.visualTreatment}`,
        true,
      );
    }
    const treatment = shot.visualTreatment as VisualTreatment;
    const [min, max] = shotDurationBounds(treatment);
    return {
      sortOrder: index,
      durationSec: Math.min(max, Math.max(min, shot.durationSec)),
      visualTreatment: treatment,
      sceneDescription: shot.sceneDescription.trim(),
      cameraDirection: shot.cameraDirection.trim() || null,
      voiceoverText: shot.voiceoverText.trim() || null,
      onScreenText: shot.onScreenText.trim() || null,
      transitionOut: shot.transitionOut,
    };
  });
  return { fullText: parsed.data.fullText.trim(), shots: fitDurations(shots, targetSec) };
}

export function fitDurations(shots: PlannedShot[], targetSec: number): PlannedShot[] {
  const total = shots.reduce((sum, s) => sum + s.durationSec, 0);
  const scaled = shots.map((s) => {
    const [min, max] = shotDurationBounds(s.visualTreatment);
    const d =
      Math.round(Math.min(max, Math.max(min, (s.durationSec * targetSec) / total)) * 10) / 10;
    return { ...s, durationSec: d };
  });
  let remainder =
    Math.round((targetSec - scaled.reduce((sum, s) => sum + s.durationSec, 0)) * 10) / 10;
  // Spread any remainder over shots that still have room, longest first.
  const order = [...scaled.keys()].sort(
    (a, b) => (scaled[b]?.durationSec ?? 0) - (scaled[a]?.durationSec ?? 0),
  );
  for (const i of order) {
    if (Math.abs(remainder) < 0.05) break;
    const shot = scaled[i];
    if (!shot) continue;
    const [min, max] = shotDurationBounds(shot.visualTreatment);
    const next = Math.round(Math.min(max, Math.max(min, shot.durationSec + remainder)) * 10) / 10;
    remainder = Math.round((remainder - (next - shot.durationSec)) * 10) / 10;
    scaled[i] = { ...shot, durationSec: next };
  }
  return scaled;
}
