import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  NoProviderAvailableError,
  ProviderError,
  RateDeferredError,
  ValidationError,
} from '../../errors';
import {
  WALL_TEXT_MAX_CHARS,
  WALL_TEXT_MAX_LINES,
  WALL_TEXT_MAX_WORDS,
  tidyWallText,
} from './copy-prompt';
import { wordCount } from './hook-demo';

// BACKLOG 22.2 — "Wall of text" (Fastlane research, operator request 2026-10-05): one calm,
// faceless background video, a music bed and ONE large block of text (a short list or statement,
// ~20–60 words) on screen for the whole video (6–12 s), in the TikTok-classic look (white, black
// stroke, no box; formats/caption-style.ts) inside the safe area. The project keeps its choices in
// metadata.wallOfText.
//
// Background footage, in order (Studio decision 2026-10-05):
//   1. a reference-library video in a matching category that is explicitly licensed for use as
//      footage (licence allowedModes includes FOOTAGE; formats/footage.ts) — the library is a
//      reference corpus, so nothing is reused as footage unless the operator licensed it so;
//   2. stock footage through the existing STOCK_FOOTAGE route (Storyblocks video, then Pexels
//      video; providers/router.ts), searched with the mood's query. Pixabay videos were not added:
//      Studio's Pixabay adapter is images only, and no new provider request shape was needed.

export const WALL_BACKGROUNDS = ['calm', 'nature', 'city', 'abstract'] as const;
export type WallBackground = (typeof WALL_BACKGROUNDS)[number];

export const WALL_MIN_SEC = 6;
export const WALL_MAX_SEC = 12;
export const WALL_DEFAULT_SEC = 8;
/** 22.2: a wall-of-text video counts as one video of the allowance (allowanceUnitsOf → 1). */
export const WALL_OF_TEXT_ALLOWANCE_UNITS = 1;

/**
 * Stock search text per mood. Stock searches take keywords (stock-footage.ts footageKeywords), so
 * these are short content words only — "no people" would search FOR people.
 */
export const WALL_BACKGROUND_QUERIES: Record<WallBackground, string> = {
  calm: 'calm clouds sky',
  nature: 'nature forest water',
  city: 'city night lights',
  abstract: 'abstract background',
};

/** 22.2: the stock source asked first for a wall-of-text background (production has its key). */
export const WALL_STOCK_PROVIDER = 'pixabay';

/** Reference-library category slug fragments per mood (formats/footage.ts). */
export const WALL_LIBRARY_CATEGORIES: Record<WallBackground, string[]> = {
  calm: ['aesthetic', 'faceless', 'calm'],
  nature: ['nature', 'outdoors', 'landscape'],
  city: ['city', 'urban'],
  abstract: ['abstract', 'aesthetic'],
};

const EMOJI = /\p{Extended_Pictographic}/u;

export const wallTextInput = z
  .string()
  .trim()
  .min(1)
  .max(WALL_TEXT_MAX_CHARS)
  .refine((v) => wordCount(v) <= WALL_TEXT_MAX_WORDS, {
    message: `The text can have at most ${WALL_TEXT_MAX_WORDS} words`,
  })
  .refine((v) => v.split(/\r?\n/).filter((l) => l.trim()).length <= WALL_TEXT_MAX_LINES, {
    message: `The text can have at most ${WALL_TEXT_MAX_LINES} lines`,
  })
  .refine((v) => !EMOJI.test(v), { message: 'The text cannot contain emoji' });

/** POST /projects { sourceType: WALL_OF_TEXT, wallOfText } (services/projects.ts). */
export const wallOfTextCreateInput = z
  .object({
    /** Omitted = Claude writes it from the brief and the business profile (copy-prompt.ts). */
    text: wallTextInput.optional(),
    background: z.enum(WALL_BACKGROUNDS).default('calm'),
    durationSec: z.number().int().min(WALL_MIN_SEC).max(WALL_MAX_SEC).default(WALL_DEFAULT_SEC),
  })
  .strict();
export type WallOfTextCreateInput = z.infer<typeof wallOfTextCreateInput>;

export const wallOfTextDocument = z.object({
  text: z.string().nullable(),
  background: z.enum(WALL_BACKGROUNDS),
  durationSec: z.number().int().min(WALL_MIN_SEC).max(WALL_MAX_SEC),
  /** The block the last run put on screen (the owner's, or the one Claude wrote). */
  writtenText: z.string().nullable().optional(),
});
export type WallOfTextDocument = z.infer<typeof wallOfTextDocument>;

export function readWallOfText(
  metadata: Prisma.JsonValue | null | undefined,
): WallOfTextDocument | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const parsed = wallOfTextDocument.safeParse((metadata as Record<string, unknown>).wallOfText);
  return parsed.success ? parsed.data : null;
}

export const NO_BACKGROUND_VIDEO =
  'no_background_video: no licensed library video and no stock video matched this background';

/**
 * 22.2: a wall-of-text background that no stock source could provide (none configured, or no
 * clip long enough matched) fails with a clear reason; a retryable provider problem (rate limit,
 * outage) and a deferral are passed on unchanged so the job retries or waits.
 */
export function noBackgroundVideo(err: unknown): unknown {
  if (err instanceof RateDeferredError) return err;
  if (err instanceof ProviderError && err.retryable) return err;
  if (err instanceof NoProviderAvailableError || err instanceof ProviderError)
    return new ValidationError(NO_BACKGROUND_VIDEO, { cause: err.message });
  return err;
}

export function newWallOfTextDocument(input: WallOfTextCreateInput): WallOfTextDocument {
  return {
    text: input.text ? tidyWallText(input.text) : null,
    background: input.background,
    durationSec: input.durationSec,
    writtenText: null,
  };
}
