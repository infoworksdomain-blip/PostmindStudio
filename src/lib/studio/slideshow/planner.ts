import type { Prisma, SlideType } from '@prisma/client';
import { z } from 'zod';
import { ValidationError } from '../../errors';
import {
  clampDuration,
  IMAGE_SLIDE_TYPES,
  TRANSITIONS,
  type SlideBlueprint,
  type SlideSource,
} from './templates';

// BACKLOG 7.3 / 7.5 — turn a template + the user's inputs into slide rows (A5.1). Quotes,
// statistics, prices and product features only ever come from the user: Studio never invents
// them. Listicle entries, hook and CTA may be left for auto-populate to write from a topic.

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().trim().min(1).max(64);

export const slideContent = z
  .object({
    role: z.enum(['hook', 'body', 'cta']).optional(),
    text: z.string().trim().max(300).optional(),
    caption: z.string().trim().max(300).optional(),
    number: z.number().int().min(1).max(99).optional(),
    quote: z.string().trim().max(500).optional(),
    author: z.string().trim().max(120).optional(),
    value: z.string().trim().max(40).optional(),
    label: z.string().trim().max(120).optional(),
    name: z.string().trim().max(120).optional(),
    features: z.array(z.string().trim().min(1).max(80)).max(4).optional(),
    price: z.string().trim().max(40).optional(),
    beforeImageId: id.optional(),
    afterImageId: id.optional(),
    /** Set on slides whose text auto-populate must still write. */
    pendingText: z.boolean().optional(),
    /** What auto-populate searches the image library for. */
    imageQuery: z.string().trim().max(300).optional(),
    /**
     * 22.4: a hook / closing slide drawn as large centred text over its photo, dimmed (Blitz and
     * automation slideshows, the Fastlane look) instead of a flat text card. Without a photo it
     * falls back to the text card on the brand backdrop.
     */
    headline: z.boolean().optional(),
  })
  .strict();
export type SlideContent = z.infer<typeof slideContent>;

const HEX = /^#[0-9a-fA-F]{6}$/;

export const kenBurnsSpec = z
  .object({
    effect: z.enum(['zoomIn', 'zoomOut', 'slideLeft', 'slideRight', 'slideUp', 'slideDown']),
  })
  .strict();

export const slideInput = z.object({
  slideType: z.enum([
    'IMAGE_STILL',
    'IMAGE_KENBURNS',
    'VIDEO_CLIP',
    'TEXT_CARD',
    'BEFORE_AFTER',
    'QUOTE',
    'STATISTIC',
    'PRODUCT',
  ]),
  imageAssetId: id.nullable().optional(),
  videoAssetId: id.nullable().optional(),
  backgroundColor: z.string().regex(HEX).nullable().optional(),
  durationSec: z.number().min(0.5).max(10).optional(),
  transitionIn: z.enum(TRANSITIONS).nullable().optional(),
  transitionOut: z.enum(TRANSITIONS).nullable().optional(),
  kenBurnsSpec: kenBurnsSpec.nullable().optional(),
  content: slideContent.optional(),
});
export type SlideInput = z.infer<typeof slideInput>;

export const slideshowInput = z
  .object({
    templateId: id.optional(),
    topic: text(500).optional(),
    hook: text(200).optional(),
    cta: text(200).optional(),
    items: z.array(text(200)).max(10).optional(),
    imageIds: z.array(id).max(15).optional(),
    quotes: z
      .array(z.object({ text: text(500), author: text(120).optional() }))
      .max(7)
      .optional(),
    statistics: z
      .array(z.object({ value: text(40), label: text(120) }))
      .max(5)
      .optional(),
    products: z
      .array(
        z.object({
          name: text(120),
          features: z.array(text(80)).max(4).default([]),
          price: text(40).optional(),
          imageId: id.optional(),
        }),
      )
      .max(8)
      .optional(),
    members: z
      .array(z.object({ name: text(120), role: text(120), imageId: id.optional() }))
      .max(12)
      .optional(),
    beforeImageId: id.optional(),
    afterImageId: id.optional(),
    /** Custom slideshow: explicit slides instead of a template. */
    slides: z.array(slideInput).min(1).max(40).optional(),
  })
  .refine((v) => Boolean(v.templateId) !== Boolean(v.slides), {
    message: 'Provide either templateId or slides',
  });
export type SlideshowInput = z.infer<typeof slideshowInput>;

export interface SlideDraft {
  sortOrder: number;
  slideType: SlideType;
  imageAssetId: string | null;
  videoAssetId: string | null;
  backgroundColor: string | null;
  durationSec: number;
  transitionIn: string | null;
  transitionOut: string | null;
  kenBurnsSpec: Prisma.InputJsonValue | null;
  metadata: SlideContent;
}

interface SourceEntry {
  content: SlideContent;
  imageAssetId?: string;
}

function entriesFor(source: SlideSource, input: SlideshowInput): SourceEntry[] {
  switch (source) {
    case 'items':
      return (input.items ?? []).map((item) => ({ content: { text: item, imageQuery: item } }));
    case 'images':
      return (input.imageIds ?? []).map((imageId) => ({ content: {}, imageAssetId: imageId }));
    case 'quotes':
      return (input.quotes ?? []).map((q) => ({
        content: { quote: q.text, author: q.author, imageQuery: q.text },
      }));
    case 'statistics':
      return (input.statistics ?? []).map((s) => ({
        content: { value: s.value, label: s.label, imageQuery: s.label },
      }));
    case 'products':
      return (input.products ?? []).map((p) => ({
        content: { name: p.name, features: p.features, price: p.price, imageQuery: p.name },
        imageAssetId: p.imageId,
      }));
    case 'members':
      return (input.members ?? []).map((m) => ({
        content: { name: m.name, text: m.role, imageQuery: `${m.name} ${m.role}` },
        imageAssetId: m.imageId,
      }));
  }
}

/** Sources auto-populate can fill without user data (A5.5): list items from a topic, images. */
const AUTO_FILLABLE: ReadonlySet<SlideSource> = new Set(['items', 'images']);

function draft(
  blueprint: SlideBlueprint,
  sortOrder: number,
  content: SlideContent,
  imageAssetId?: string,
): SlideDraft {
  return {
    sortOrder,
    slideType: blueprint.slideType,
    imageAssetId: imageAssetId ?? null,
    videoAssetId: null,
    backgroundColor: null,
    durationSec: clampDuration(blueprint.slideType, blueprint.durationSec),
    transitionIn: blueprint.transitionIn ?? null,
    transitionOut: null,
    kenBurnsSpec: null,
    metadata: { role: blueprint.role, ...content },
  };
}

export function expandTemplate(
  template: { name: string; slidePlan: SlideBlueprint[] },
  input: SlideshowInput,
): SlideDraft[] {
  const slides: SlideDraft[] = [];
  for (const blueprint of template.slidePlan) {
    if (!blueprint.repeat) {
      const content: SlideContent =
        blueprint.role === 'hook'
          ? input.hook
            ? { text: input.hook }
            : { pendingText: true }
          : blueprint.role === 'cta'
            ? input.cta
              ? { text: input.cta }
              : { pendingText: true }
            : blueprint.slideType === 'BEFORE_AFTER'
              ? { beforeImageId: input.beforeImageId, afterImageId: input.afterImageId }
              : {};
      if (blueprint.slideType === 'BEFORE_AFTER' && !(input.beforeImageId && input.afterImageId)) {
        throw new ValidationError(`${template.name} needs beforeImageId and afterImageId`);
      }
      slides.push(draft(blueprint, slides.length, content));
      continue;
    }
    const { source, min, max } = blueprint.repeat;
    const entries = entriesFor(source, input);
    if (entries.length > max) {
      throw new ValidationError(`${template.name} takes at most ${max} ${source}`);
    }
    if (
      entries.length < min &&
      !(AUTO_FILLABLE.has(source) && (source === 'images' || input.topic))
    ) {
      throw new ValidationError(
        `${template.name} needs ${min === max ? min : `${min}–${max}`} ${source}` +
          (source === 'items' ? ' (or a topic to write them from)' : ''),
      );
    }
    const count = Math.max(entries.length, min);
    for (let i = 0; i < count; i += 1) {
      const entry = entries[i] ?? {
        content: source === 'items' ? { pendingText: true } : {},
      };
      slides.push(
        draft(
          blueprint,
          slides.length,
          { ...entry.content, ...(blueprint.numbered && { number: i + 1 }) },
          entry.imageAssetId,
        ),
      );
    }
  }
  return slides;
}

export function customSlides(slides: SlideInput[]): SlideDraft[] {
  return slides.map((slide, index) => ({
    sortOrder: index,
    slideType: slide.slideType,
    imageAssetId: slide.imageAssetId ?? null,
    videoAssetId: slide.videoAssetId ?? null,
    backgroundColor: slide.backgroundColor ?? null,
    durationSec: clampDuration(slide.slideType, slide.durationSec ?? 2.5),
    transitionIn: slide.transitionIn ?? null,
    transitionOut: slide.transitionOut ?? null,
    kenBurnsSpec: (slide.kenBurnsSpec as Prisma.InputJsonValue | undefined) ?? null,
    metadata: slide.content ?? {},
  }));
}

/** Why a slide cannot be rendered yet (null = ready). */
export function slideProblem(slide: {
  slideType: SlideType;
  imageAssetId: string | null;
  videoAssetId: string | null;
  metadata: SlideContent;
}): string | null {
  const m = slide.metadata;
  if (m.pendingText) return 'text not written yet (run auto-populate or edit the slide)';
  if (IMAGE_SLIDE_TYPES.has(slide.slideType) && !slide.imageAssetId) return 'needs an image';
  switch (slide.slideType) {
    case 'VIDEO_CLIP':
      return slide.videoAssetId ? null : 'needs a video clip';
    case 'TEXT_CARD':
      return m.text ? null : 'needs text';
    case 'BEFORE_AFTER':
      return m.beforeImageId && m.afterImageId ? null : 'needs before and after images';
    case 'QUOTE':
      return m.quote ? null : 'needs a quote';
    case 'STATISTIC':
      return m.value && m.label ? null : 'needs a value and label';
    case 'PRODUCT':
      return m.name ? null : 'needs a product name';
    default:
      return null;
  }
}

export function parseSlideContent(value: unknown): SlideContent {
  const parsed = slideContent.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}
