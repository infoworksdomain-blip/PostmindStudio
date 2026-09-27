import type { BrandKit, Prisma, PrismaClient, SlideshowSlide } from '@prisma/client';
import type { PlacedOverlay } from '../overlays/compose';
import { applyBrand, resolveStyle } from '../overlays/params';
import { BUILT_IN_PRESETS } from '../overlays/presets';
import { parseSlideContent, type SlideContent } from './planner';

// Phase 13.4 — per-slide overlays (text_overlays.slideId).
//   * Composition places each slide's overlays at the slide's start (slideOverlayPlacements).
//   * A slideshow template's overlayDefaults ({ <role>: { preset } }, A5.1) are applied once, at
//     the first generation, to the image slides of that role that have no overlays yet: the
//     slide's caption becomes a styled overlay with the recipe's preset. Other slide types
//     (quote, statistic, product, before/after) keep their structured layout from slideshow/edl.
//
// DECISION: the recipe names in the built-in templates are not preset keys, so they map to the
// closest built-in preset; a recipe that is already a built-in preset key is used as is.

export const RECIPE_PRESET: Record<string, string> = {
  listicle_number: 'subtitle_box',
  name_and_role: 'quote_author_byline',
  before_after_labels: 'subtitle_box',
  product_callouts: 'cta_pulse_button',
  quote_card: 'quote_serif',
  big_number: 'stat_big_number',
};

const CAPTIONED_TYPES = new Set(['IMAGE_STILL', 'IMAGE_KENBURNS']);

export function presetKeyForRecipe(recipe: string): string | null {
  if (BUILT_IN_PRESETS.some((p) => p.key === recipe)) return recipe;
  return RECIPE_PRESET[recipe] ?? null;
}

/** The caption slideshow/edl.ts draws for an image slide (same rule). */
export function slideCaption(content: SlideContent): string | null {
  const label = [content.number ? `${content.number}.` : null, content.name, content.text]
    .filter(Boolean)
    .join(' ');
  return content.caption ?? (label || null);
}

/** Recipe per role from a template's overlayDefaults JSON. */
export function recipesByRole(value: Prisma.JsonValue | null): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([role, spec]) => {
      const preset =
        spec && typeof spec === 'object' && !Array.isArray(spec)
          ? (spec as Record<string, unknown>).preset
          : undefined;
      return typeof preset === 'string' ? [[role, preset]] : [];
    }),
  );
}

export interface DefaultSlideOverlay {
  slideId: string;
  text: string;
  presetKey: string;
  durationSec: number;
}

/** Which slides get a default overlay, and with what text and preset. */
export function defaultSlideOverlays(
  slides: Array<Pick<SlideshowSlide, 'id' | 'slideType' | 'durationSec' | 'metadata'>>,
  recipes: Record<string, string>,
  slidesWithOverlays: Set<string>,
): DefaultSlideOverlay[] {
  return slides.flatMap((slide) => {
    if (!CAPTIONED_TYPES.has(slide.slideType) || slidesWithOverlays.has(slide.id)) return [];
    const content = parseSlideContent(slide.metadata);
    const recipe = recipes[content.role ?? 'body'];
    const presetKey = recipe ? presetKeyForRecipe(recipe) : null;
    const text = slideCaption(content)?.slice(0, 500);
    return presetKey && text
      ? [{ slideId: slide.id, text, presetKey, durationSec: slide.durationSec }]
      : [];
  });
}

/**
 * Apply the template's overlay defaults for this project. Returns how many overlays were
 * created; the caller records that it ran so later runs keep the owner's edits.
 */
export async function applyTemplateOverlayDefaults(
  db: PrismaClient,
  input: { projectId: string; templateId: string | null; brandKit: BrandKit | null },
): Promise<number> {
  if (!input.templateId) return 0;
  const template = await db.slideshowTemplate.findUnique({ where: { id: input.templateId } });
  const recipes = recipesByRole(template?.overlayDefaults ?? null);
  if (Object.keys(recipes).length === 0) return 0;
  const slides = await db.slideshowSlide.findMany({
    where: { projectId: input.projectId },
    include: { overlays: { select: { id: true } } },
    orderBy: { sortOrder: 'asc' },
  });
  const defaults = defaultSlideOverlays(
    slides,
    recipes,
    new Set(slides.filter((s) => s.overlays.length > 0).map((s) => s.id)),
  );
  if (defaults.length === 0) return 0;
  const palette = Array.isArray(input.brandKit?.colourPalette)
    ? (input.brandKit.colourPalette as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];
  const brand = input.brandKit
    ? {
        primary: palette[0],
        secondary: palette[1],
        fontFamily: input.brandKit.fontPrimary ?? undefined,
      }
    : null;
  const presets = await db.overlayPreset.findMany({
    where: { scope: 'BUILT_IN', name: { in: BUILT_IN_PRESETS.map((p) => p.name) } },
    select: { id: true, name: true },
  });
  const presetIdByName = new Map(presets.map((p) => [p.name, p.id]));
  const rows: Prisma.TextOverlayCreateManyInput[] = defaults.flatMap((d) => {
    const preset = BUILT_IN_PRESETS.find((p) => p.key === d.presetKey);
    if (!preset) return [];
    const base = resolveStyle(preset.parameters);
    const style = preset.brandSubstitution ? applyBrand(base, brand) : base;
    return [
      {
        slideId: d.slideId,
        presetId: presetIdByName.get(preset.name) ?? null,
        text: d.text,
        startAtSec: 0,
        endAtSec: Math.max(0.5, d.durationSec),
        ...style,
        effect: (style.effect ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    ];
  });
  if (rows.length) await db.textOverlay.createMany({ data: rows });
  return rows.length;
}

/** Overlays per slide (in slide order), each placed at its slide's start. */
export async function slideOverlayPlacements(
  db: Pick<PrismaClient, 'slideshowSlide'>,
  projectId: string,
): Promise<PlacedOverlay[][]> {
  const slides = await db.slideshowSlide.findMany({
    where: { projectId },
    orderBy: { sortOrder: 'asc' },
    select: { durationSec: true, overlays: true },
  });
  let offset = 0;
  return slides.map((slide) => {
    const at = offset;
    offset += slide.durationSec;
    return slide.overlays.map((row) => ({ row, offsetSec: at }));
  });
}
