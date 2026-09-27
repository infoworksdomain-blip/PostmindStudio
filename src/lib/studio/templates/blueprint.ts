import type { PrismaClient, VideoProject } from '@prisma/client';
import { z } from 'zod';
import { OVERLAY_STYLES, SHOT_TYPES, type ShotType } from '../library/analyse';
import {
  applyTemplate,
  descriptor,
  OVERLAY_STYLE_PRESET,
  templateConstraint,
  type Blueprint,
} from '../library/blueprint';
import type { ReferenceGuide } from '../library/reference';

// Project templates (spec 7.12 `templates`, 8.6). templates.shotBlueprint stores the same
// structural blueprint the library TEMPLATE mode derives from a reference video (A3.6), so a
// template constrains Layer 2 exactly the way a library reference does: same shot count, the
// blueprint's durations scaled to each format, treatments by shot role, overlay presets.
// DERIVED: the spec gives the column (Json) but not its shape.

export const templateShot = z
  .object({
    durationSec: z.number().min(0.5).max(600),
    type: z.enum(SHOT_TYPES),
    overlayStyle: z.enum(OVERLAY_STYLES).default('none'),
    voiceoverPresent: z.boolean().default(true),
    hasOnScreenText: z.boolean().default(false),
  })
  .strict();

export const templateBlueprint = z
  .object({
    shots: z.array(templateShot).min(1).max(40),
    hookPattern: z.string().max(200).default(''),
    structurePattern: z.string().max(200).default(''),
    ctaPattern: z.string().max(200).nullable().default(null),
    paceTag: z.string().max(40).default('medium'),
  })
  .strict();

export type TemplateBlueprint = z.infer<typeof templateBlueprint>;

export function toBlueprint(stored: TemplateBlueprint): Blueprint {
  const totalDurationSec =
    Math.round(stored.shots.reduce((t, s) => t + s.durationSec, 0) * 100) / 100;
  return {
    shotCount: stored.shots.length,
    totalDurationSec,
    shots: stored.shots,
    musicEnvelope: { bpm: null, energy: null, moodTag: null },
    transitionSequence: stored.shots.map(() => 'cut'),
    hookPattern: stored.hookPattern,
    structurePattern: stored.structurePattern,
    ctaPattern: stored.ctaPattern,
    paceTag: stored.paceTag,
  };
}

// ------------------------------------------------------------ from a project's current script

/** Shot role for a generated shot: first = hook, last text card = CTA, else by treatment. */
export function shotTypeFor(
  treatment: string,
  index: number,
  count: number,
  hasText: boolean,
): ShotType {
  if (index === count - 1 && treatment === 'TEXT_CARD') return 'CTA_CARD';
  if (index === 0 && hasText && (treatment === 'IMAGE_STILL' || treatment === 'TEXT_CARD'))
    return 'HOOK_TEXT_ON_STILL';
  switch (treatment) {
    case 'AI_AVATAR':
      return 'AVATAR_TALKING';
    case 'STOCK_FOOTAGE':
      return 'STOCK_LIFESTYLE';
    case 'IMAGE_STILL':
      return 'PRODUCT_SHOT';
    case 'MOTION_GRAPHICS':
      return 'SCREEN_RECORDING';
    case 'TEXT_CARD':
      return 'TEXT_CARD';
    default:
      return 'AI_CLIP_ACTION';
  }
}

/** Overlay preset → blueprint overlay style (first style listed for a preset wins). */
const PRESET_STYLE = new Map<string, (typeof OVERLAY_STYLES)[number]>();
for (const [style, preset] of Object.entries(OVERLAY_STYLE_PRESET)) {
  if (preset && !PRESET_STYLE.has(preset))
    PRESET_STYLE.set(preset, style as (typeof OVERLAY_STYLES)[number]);
}

export interface ShotShape {
  durationSec: number;
  visualTreatment: string;
  voiceoverText: string | null;
  onScreenText: string | null;
  overlayPresetNames: string[];
}

function paceOf(shots: ShotShape[]): string {
  const avg = shots.reduce((t, s) => t + s.durationSec, 0) / shots.length;
  return avg < 2.5 ? 'fast-cut' : avg < 5 ? 'medium' : 'slow';
}

/** "Save as template": the structure of a script, none of its words. */
export function blueprintFromShots(shots: ShotShape[]): TemplateBlueprint {
  const types = shots.map((s, i) =>
    shotTypeFor(s.visualTreatment, i, shots.length, Boolean(s.onScreenText?.trim())),
  );
  return {
    shots: shots.map((s, i) => ({
      durationSec: Math.max(0.5, Math.round(s.durationSec * 10) / 10),
      type: types[i] ?? 'AI_CLIP_ACTION',
      overlayStyle:
        s.overlayPresetNames.map((n) => PRESET_STYLE.get(n)).find((v) => v !== undefined) ?? 'none',
      voiceoverPresent: Boolean(s.voiceoverText?.trim()),
      hasOnScreenText: Boolean(s.onScreenText?.trim()),
    })),
    hookPattern: `${(types[0] ?? 'AI_CLIP_ACTION').toLowerCase().replace(/_/g, ' ')} opening`,
    structurePattern: [...new Set(types.map((t) => t.toLowerCase().replace(/_/g, ' ')))]
      .join(', ')
      .slice(0, 200),
    ctaPattern: types.at(-1) === 'CTA_CARD' ? 'closing call-to-action card' : null,
    paceTag: paceOf(shots),
  };
}

// ------------------------------------------------------------ script template

const VAR = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]{0,40})\s*\}\}/g;

/**
 * Render the Handlebars-style scriptTemplate (spec 7.12) with plain {{var}} substitution — no
 * helpers, no HTML. Values are flattened and stripped of braces/angle brackets; unknown
 * variables become empty. The result is a brief for Layer 1, never executed.
 */
export function renderScriptTemplate(template: string, vars: Record<string, string>): string {
  return template
    .replace(VAR, (_m, name: string) =>
      Object.hasOwn(vars, name) ? descriptor(vars[name], 500) : '',
    )
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, 4_000);
}

// ------------------------------------------------------------ planning

/** Layer 2 guide for a TEMPLATE project; null when the template has no usable blueprint. */
export async function loadTemplateGuide(
  db: Pick<PrismaClient, 'template'>,
  project: Pick<VideoProject, 'sourceType' | 'templateId' | 'organisationId'>,
): Promise<ReferenceGuide | null> {
  if (project.sourceType !== 'TEMPLATE' || !project.templateId) return null;
  const template = await db.template.findFirst({
    where: {
      id: project.templateId,
      OR: [{ organisationId: null }, { organisationId: project.organisationId }],
    },
    select: { id: true, shotBlueprint: true },
  });
  const parsed = templateBlueprint.safeParse(template?.shotBlueprint);
  if (!template || !parsed.success) return null;
  const blueprint = toBlueprint(parsed.data);
  return {
    mode: 'TEMPLATE',
    referenceVideoId: null,
    templateId: template.id,
    ideationSupplement: null,
    scriptSupplement: (targetSec, treatments) =>
      templateConstraint(blueprint, targetSec, treatments),
    apply: (plan, targetSec) => applyTemplate(plan, blueprint, targetSec),
    presetForShot: (index) => {
      const style = blueprint.shots[index]?.overlayStyle;
      return style ? OVERLAY_STYLE_PRESET[style] : null;
    },
    blueprint,
  };
}
