import { VideoSourceType } from '@prisma/client';
import type { Platform } from '../services/catalog';
import { CAROUSEL_PLATFORMS } from '../carousel/publishing';

// 22.4 / 22.5 — the format registry Blitz and automations choose from (Fastlane research,
// plans/research-fastlane-2026-10-05.md: weights add up to 100, cheap formats are assembled from
// existing media + LLM copy + a compositor). Each entry says how expensive the format is to make,
// whether it is rendered BEFORE it is shown ("premade": carousel = our own sharp renderer,
// slideshow = Shotstack, a few pence) or shown as a PREVIEW that only generates after a keep
// (AI video, UGC), and which platforms take it.
//
// 22.1 (HOOK_DEMO, WALL_OF_TEXT) and later formats plug in as entries: a format is offered only
// when its VideoSourceType exists in the generated Prisma enum AND a project builder has been
// registered for it (registerFormatBuilder), so this file ships before those branches land.

export const FORMAT_KEYS = [
  'carousel',
  'slideshow',
  'wall_of_text',
  'hook_demo',
  'ai_video',
  'ugc',
] as const;
export type FormatKey = (typeof FORMAT_KEYS)[number];

export type FormatTier = 'premade' | 'preview';

/** The month-plan item kind a format is made as (null = not plannable yet). */
export type PlanItemKind = 'VIDEO' | 'SLIDESHOW' | 'CAROUSEL';

export interface FormatEntry {
  readonly key: FormatKey;
  /** The VideoSourceType the format's project uses. */
  readonly sourceType: string;
  readonly tier: FormatTier;
  /** 1 = cheapest. Automations fill slots cheapest first. */
  readonly costRank: number;
  /** Default weight (owner-editable; paid formats default to 0). */
  readonly defaultWeight: number;
  /** Month-plan item kind; null until the format's builder is registered. */
  readonly planKind: PlanItemKind | null;
  /** Needs a user-uploaded demo video (Fastlane `no_demo_video`). */
  readonly needsDemoVideo?: boolean;
  /** Platforms that take the format (Fastlane: YouTube gets no slideshows or carousels). */
  readonly platforms: (platform: Platform) => boolean;
}

const NOT_YOUTUBE = (p: Platform) => p !== 'youtube' && p !== 'youtube_short';
const ANY = () => true;

export const FORMATS: Readonly<Record<FormatKey, FormatEntry>> = {
  carousel: {
    key: 'carousel',
    sourceType: 'CAROUSEL',
    tier: 'premade',
    costRank: 1,
    defaultWeight: 35,
    planKind: 'CAROUSEL',
    platforms: (p) => CAROUSEL_PLATFORMS.includes(p),
  },
  slideshow: {
    key: 'slideshow',
    sourceType: 'SLIDESHOW',
    tier: 'premade',
    costRank: 2,
    defaultWeight: 35,
    planKind: 'SLIDESHOW',
    platforms: NOT_YOUTUBE,
  },
  wall_of_text: {
    key: 'wall_of_text',
    sourceType: 'WALL_OF_TEXT',
    tier: 'premade',
    costRank: 3,
    defaultWeight: 15,
    // 22.2: a video project (WALL_OF_TEXT) in month plans.
    planKind: 'VIDEO',
    platforms: NOT_YOUTUBE,
  },
  hook_demo: {
    key: 'hook_demo',
    sourceType: 'HOOK_DEMO',
    tier: 'premade',
    costRank: 4,
    defaultWeight: 15,
    // 22.1: a video project (HOOK_DEMO); offered per business only with a demo video and a
    // licensed library hook clip (formats/availability.ts).
    planKind: 'VIDEO',
    needsDemoVideo: true,
    platforms: ANY,
  },
  ai_video: {
    key: 'ai_video',
    sourceType: 'BRIEF',
    tier: 'preview',
    costRank: 10,
    defaultWeight: 0,
    planKind: 'VIDEO',
    platforms: ANY,
  },
  ugc: {
    key: 'ugc',
    sourceType: 'BRIEF',
    tier: 'preview',
    costRank: 20,
    defaultWeight: 0,
    planKind: 'VIDEO',
    platforms: ANY,
  },
};

/** Formats whose builder ships in blitz/project-body.ts (22.1 / 22.2 added theirs). */
const BUILT_IN: ReadonlySet<FormatKey> = new Set([
  'carousel',
  'slideshow',
  'wall_of_text',
  'hook_demo',
  'ai_video',
  'ugc',
]);
const registered = new Set<FormatKey>();

/**
 * 22.1 hook: a format phase registers its project builder here once its renderer exists, so
 * Blitz and automations start offering it (still only when its sourceType is in the enum).
 */
export function registerFormatBuilder(key: FormatKey): void {
  registered.add(key);
}

/** The VideoSourceType values the generated Prisma client knows. */
export function knownSourceTypes(): readonly string[] {
  return Object.values(VideoSourceType);
}

/** The formats Studio can make right now, cheapest first. */
export function availableFormats(sourceTypes: readonly string[] = knownSourceTypes()): FormatKey[] {
  return FORMAT_KEYS.filter(
    (key) =>
      sourceTypes.includes(FORMATS[key].sourceType) && (BUILT_IN.has(key) || registered.has(key)),
  ).sort((a, b) => FORMATS[a].costRank - FORMATS[b].costRank);
}

export function isFormatKey(value: unknown): value is FormatKey {
  return typeof value === 'string' && (FORMAT_KEYS as readonly string[]).includes(value);
}

export function isPremade(key: FormatKey): boolean {
  return FORMATS[key].tier === 'premade';
}

/** Default weights over the available formats (unavailable ones are simply absent). */
export function defaultFormatWeights(
  available: readonly FormatKey[] = availableFormats(),
): Partial<Record<FormatKey, number>> {
  return Object.fromEntries(available.map((key) => [key, FORMATS[key].defaultWeight]));
}

/** The platforms among `platforms` that take `key`. */
export function platformsFor(key: FormatKey, platforms: readonly string[]): Platform[] {
  return (platforms as Platform[]).filter((p) => FORMATS[key].platforms(p));
}
