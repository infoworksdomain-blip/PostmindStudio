import type { z } from 'zod';
import { MAX_POSTS } from '../carousel/constants';
import { PLATFORM_RULES } from '../platforms/rules';
import type { Platform } from '../services/catalog';
import type { createProjectInput } from '../services/projects';
import { NotImplementedError } from '../../errors';
import type { FormatKey } from './formats';
import { tidyHookLine, tidyWallText } from '../formats/copy-prompt';
import { wordCount } from '../formats/hook-demo';
import { WALL_MAX_SEC, WALL_MIN_SEC } from '../formats/wall-of-text';

/** The month plans' photo-slide length and Ken Burns cycle (content-plan-run.ts, 20.26). */
const PLAN_PHOTO_SLIDE_SEC = 2.5;
const KEN_BURNS_CYCLE = ['zoomIn', 'slideLeft', 'zoomOut', 'slideRight'] as const;

// 22.4 / 22.5 — one written card → the POST /projects body of its format, validated by
// createProjectInput like any other project:
//   carousel  → CAROUSEL with the posts already written (hook, one idea per post, closing post),
//               so planning only finds pictures (library → free stock) and renders with sharp;
//   slideshow → SLIDESHOW of photo slides: the hook and closing slides are large text over a
//               dimmed photo (content.headline), the body lines are Ken Burns photo slides with
//               their text — pictures by meaning from the library or free stock;
//   ai_video  → BRIEF (15 s, the cheapest short), the hook and beats in the brief;
//   ugc       → BRIEF with the UGC actor style (counts UGC_VIDEO_ALLOWANCE_UNITS).

export interface CardCopy {
  title: string;
  hook: string;
  body: string[];
  cta: string;
  imageQueries?: string[];
}

export interface BodyOptions {
  businessId: string;
  language: string;
  brandKitId?: string | null;
  /** Platforms to render for (video formats); carousels have fixed destinations. */
  platforms: readonly Platform[];
  /** 22.4: "blitz:<suggestionId>" while a pre-made card waits for a swipe. */
  sourceRef?: string;
  /** Video length (15 s by default: the cheapest short that still carries a hook and beats). */
  durationSec?: number;
}

type ProjectBody = z.input<typeof createProjectInput>;

export const CARD_VIDEO_SEC = 15;
/** The text a slide's photo is searched by: its own query, else its line. */
const queryOf = (copy: CardCopy, index: number, fallback: string) =>
  (copy.imageQueries?.[index] ?? '').trim() || fallback;

export function carouselThread(copy: CardCopy): string {
  return [copy.hook, ...copy.body, ...(copy.cta ? [copy.cta] : [])]
    .slice(0, MAX_POSTS)
    .join('\n---\n');
}

function targetFormats(platforms: readonly Platform[], durationSec: number) {
  return platforms.map((platform) => ({
    platform,
    aspectRatio: PLATFORM_RULES[platform].aspectRatios[0]!,
    durationSec,
  }));
}

function slideshowSlides(copy: CardCopy) {
  const headline = (role: 'hook' | 'cta', text: string, query: string) => ({
    slideType: 'IMAGE_STILL' as const,
    durationSec: PLAN_PHOTO_SLIDE_SEC,
    transitionIn: 'fade' as const,
    content: { role, text: text.slice(0, 300), imageQuery: query.slice(0, 300), headline: true },
  });
  const photo = (text: string, index: number) => ({
    slideType: 'IMAGE_KENBURNS' as const,
    durationSec: PLAN_PHOTO_SLIDE_SEC,
    transitionIn: 'fade' as const,
    kenBurnsSpec: { effect: KEN_BURNS_CYCLE[index % KEN_BURNS_CYCLE.length]! },
    content: {
      role: 'body' as const,
      text: text.slice(0, 300),
      imageQuery: queryOf(copy, index, text).slice(0, 300),
    },
  });
  return [
    headline('hook', copy.hook, copy.title),
    ...copy.body.map(photo),
    headline('cta', copy.cta || copy.title, queryOf(copy, copy.body.length - 1, copy.title)),
  ];
}

function briefText(copy: CardCopy): string {
  return [
    copy.title,
    '',
    `Hook: ${copy.hook}`,
    'Beats:',
    ...copy.body.map((b) => `- ${b}`),
    ...(copy.cta ? [`Call to action: ${copy.cta}`] : []),
  ]
    .join('\n')
    .slice(0, 4_000);
}

/** The create body for `format`, without publishing settings (the caller adds those). */
export function projectBodyForCard(
  format: FormatKey,
  copy: CardCopy,
  options: BodyOptions,
): ProjectBody {
  const common = {
    name: copy.title.slice(0, 200),
    businessId: options.businessId,
    language: options.language,
    ...(options.brandKitId && { brandKitId: options.brandKitId }),
    ...(options.sourceRef && { sourceRef: options.sourceRef }),
  };
  const durationSec = options.durationSec ?? CARD_VIDEO_SEC;
  switch (format) {
    case 'carousel':
      return {
        ...common,
        sourceType: 'CAROUSEL',
        brief: {
          rawInput: briefText(copy),
          ...(copy.cta && { callToAction: copy.cta.slice(0, 200) }),
        },
        carousel: { theme: 'light', postCount: 7, thread: carouselThread(copy) },
      };
    case 'slideshow':
      return {
        ...common,
        sourceType: 'SLIDESHOW',
        targetFormats: targetFormats(options.platforms, durationSec),
        slideshow: { topic: copy.title.slice(0, 500), slides: slideshowSlides(copy) },
      };
    case 'ugc':
    case 'ai_video':
      return {
        ...common,
        sourceType: 'BRIEF',
        targetFormats: targetFormats(options.platforms, durationSec),
        brief: {
          rawInput: briefText(copy),
          ...(copy.cta && { callToAction: copy.cta.slice(0, 200) }),
        },
        ...(format === 'ugc' && { ugc: {} }),
      };
    case 'wall_of_text':
      return {
        ...common,
        sourceType: 'WALL_OF_TEXT',
        targetFormats: targetFormats(options.platforms, wallSec(durationSec)),
        brief: { rawInput: briefText(copy) },
        wallOfText: wallOfTextFor(copy, wallSec(durationSec)),
      };
    case 'hook_demo':
      return {
        ...common,
        sourceType: 'HOOK_DEMO',
        targetFormats: targetFormats(options.platforms, durationSec),
        brief: { rawInput: briefText(copy) },
        hookDemo: hookDemoFor(copy),
      };
    default:
      throw new NotImplementedError(`No project builder for format ${format}`);
  }
}

/** 22.2: a wall of text lasts 6–12 s (the card's video length clamped into it). */
const wallSec = (sec: number) => Math.min(WALL_MAX_SEC, Math.max(WALL_MIN_SEC, Math.round(sec)));

/** 22.2: the card's hook and lines as the block (≤ 60 words, one idea per line, no emoji). */
export function wallOfTextFor(copy: CardCopy, durationSec: number) {
  const text = tidyWallText([copy.hook, ...copy.body.map((b) => `- ${b}`)].join('\n'));
  return { ...(wordCount(text) >= 3 && { text }), background: 'calm' as const, durationSec };
}

/**
 * 22.1: the card's hook as the hook line (≤ 12 words, one line), the business's newest demo,
 * and a LIBRARY reaction hook: a card is made before anyone keeps it, so it never pays for a
 * generated clip (formats/availability.ts offers the format only when such a clip exists).
 */
export function hookDemoFor(copy: CardCopy) {
  const hookLine = tidyHookLine(copy.hook);
  return {
    ...(wordCount(hookLine) >= 2 && { hookLine }),
    hookSource: 'library' as const,
    allowGeneratedHook: false,
  };
}
