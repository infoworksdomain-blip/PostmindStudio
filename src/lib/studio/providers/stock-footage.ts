import type { AspectRatio } from './interface';

// Shared helpers for the Layer 3 STOCK_FOOTAGE adapters (storyblocks-video.ts, pexels-video.ts).
// A stock search takes keywords, not a generator prompt, so the shot's scene description is
// reduced to its content words.

const MAX_KEYWORDS = 6;
const MAX_KEYWORD_CHARS = 100;

// Words that carry no search value in a scene description (camera and light vocabulary included:
// every clip has light and a camera, so these only dilute the search).
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'by',
  'camera',
  'close',
  'closeup',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'its',
  'light',
  'lighting',
  'of',
  'on',
  'onto',
  'or',
  'over',
  'shot',
  'slow',
  'slowly',
  'the',
  'their',
  'then',
  'to',
  'up',
  'with',
  'while',
]);

/** Content words of a scene description, in order, deduplicated, at most six. */
export function footageKeywords(description: string): string[] {
  const words = description
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // hyphens split words: "close-up" → "close up"
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  const unique: string[] = [];
  let chars = 0;
  for (const word of words) {
    if (unique.includes(word)) continue;
    if (unique.length >= MAX_KEYWORDS || chars + word.length > MAX_KEYWORD_CHARS) break;
    unique.push(word);
    chars += word.length + 1;
  }
  return unique;
}

/** Portrait formats want vertical clips; square-ish formats accept either (cropped by Layer 6). */
export function footageOrientation(aspect: AspectRatio): 'vertical' | 'horizontal' | 'any' {
  if (aspect === '9:16') return 'vertical';
  if (aspect === '16:9') return 'horizontal';
  return 'any';
}

/** Licence facts stored on the asset (video_assets.metadata.licence) for every stock clip. */
export interface StockLicence {
  /** Which licence governs the clip. */
  licence: 'storyblocks-api' | 'pexels';
  licenceUrl: string;
  /** Neither licence requires on-video attribution; credit is still recorded. */
  attributionRequired: false;
  creator: string | null;
  creatorUrl: string | null;
  sourcePageUrl: string | null;
}
