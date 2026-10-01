import { ValidationError } from '../../errors';

// 20.13 — the business hashtag (operator request 2026-10-01): every post carries one primary
// hashtag for the business, by default derived from its name ("AheadAi" → #AheadAI) and editable
// in Business settings. Hashtags are letters (any script), combining marks, digits and
// underscores; the business hashtag is at most 30 characters and has at least one letter
// (an all-digit tag is not linked by the platforms).
// DECISION: non-Latin names keep their own script (Arabic, Devanagari, Han…): Instagram, TikTok,
// X, YouTube, LinkedIn and Facebook all link Unicode hashtags, so "مخبز الشام" becomes
// #مخبزالشام rather than a transliteration Studio would have to guess. Names with no letters
// at all (e.g. "123") have no default: the owner types one.

export const BUSINESS_HASHTAG_MAX_CHARS = 30;
/** Owner "always include" hashtags: the same 30-character cap keeps five of them within X's 280. */
export const ALWAYS_HASHTAG_MAX_CHARS = 30;
export const MAX_ALWAYS_HASHTAGS = 10;

const TAG_BODY = /^[\p{L}\p{N}_][\p{L}\p{M}\p{N}_]*$/u;
const HAS_LETTER = /\p{L}/u;
const NOT_TAG_CHAR = /[^\p{L}\p{M}\p{N}_]/gu;
const CAMEL_BOUNDARY = /(?<=\p{Ll})(?=\p{Lu})/u;

/** Two/three-letter words written in capitals inside a hashtag (#AheadAI, #LeedsBBQ). */
const ACRONYMS = new Set(['ai', 'uk', 'eu', 'usa', 'tv', 'hr', 'pr', 'seo', 'diy', 'bbq', 'nhs']);
/** Legal-form suffixes left off the default hashtag ("Leeds Sourdough Ltd" → #LeedsSourdough). */
const LEGAL_SUFFIXES = new Set([
  'ltd',
  'limited',
  'plc',
  'llp',
  'llc',
  'inc',
  'co',
  'gmbh',
  'sarl',
  'srl',
  'bv',
  'pty',
]);

const codePoints = (s: string) => [...s].length;

function casedWord(word: string): string {
  const lower = word.toLocaleLowerCase('en-GB');
  const upper = word.toLocaleUpperCase('en-GB');
  // Uncased scripts (Arabic, Han, Devanagari…) are left exactly as written.
  if (lower === upper) return word;
  // SHOUTED words longer than an acronym become Title case; short ones (BBC) stay.
  const base = word === upper && codePoints(word) > 3 ? lower : word;
  const titled =
    base === base.toLocaleLowerCase('en-GB')
      ? base.charAt(0).toLocaleUpperCase('en-GB') + base.slice(1)
      : base;
  return titled
    .split(CAMEL_BOUNDARY)
    .map((piece) =>
      ACRONYMS.has(piece.toLocaleLowerCase('en-GB')) ? piece.toLocaleUpperCase('en-GB') : piece,
    )
    .join('');
}

function words(phrase: string): string[] {
  return phrase
    .normalize('NFC')
    .replace(/[’'`]/g, '')
    .split(/\s+|[-–—/&+.,:;!?()[\]{}"|\\]+/u)
    .map((w) => w.replace(NOT_TAG_CHAR, ''))
    .filter(Boolean);
}

function joinWithin(parts: string[], maxChars: number): string {
  let out = '';
  for (const part of parts) {
    if (codePoints(out + part) > maxChars) break;
    out += part;
  }
  // One very long first word: cut it rather than return nothing.
  if (!out && parts[0]) out = [...parts[0]].slice(0, maxChars).join('');
  return out;
}

/**
 * A phrase as one CamelCase hashtag without "#" ("small business" → "SmallBusiness"), or null
 * when nothing usable is left. Used for the default business hashtag and for turning business
 * profile phrases (industry, regions, products) into top-up hashtags.
 */
export function phraseToHashtag(
  phrase: string,
  maxChars = BUSINESS_HASHTAG_MAX_CHARS,
): string | null {
  const parts = words(phrase).map(casedWord);
  const tag = joinWithin(parts, maxChars);
  return tag && HAS_LETTER.test(tag) && TAG_BODY.test(tag) ? tag : null;
}

/** The default business hashtag for a business name (no "#"), or null when none can be made. */
export function deriveBusinessHashtag(name: string | null | undefined): string | null {
  if (!name) return null;
  const all = words(name);
  const trimmed = [...all];
  while (trimmed.length > 1 && LEGAL_SUFFIXES.has(trimmed.at(-1)!.toLocaleLowerCase('en-GB')))
    trimmed.pop();
  return phraseToHashtag(trimmed.join(' '));
}

export type HashtagProblem = 'empty' | 'characters' | 'too_long' | 'needs_letter';

/** Why `raw` is not a valid owner hashtag (null = valid). */
export function hashtagProblem(raw: string, maxChars: number): HashtagProblem | null {
  const tag = raw.trim().replace(/^#+/, '').normalize('NFC');
  if (!tag) return 'empty';
  if (!TAG_BODY.test(tag)) return 'characters';
  if (codePoints(tag) > maxChars) return 'too_long';
  if (!HAS_LETTER.test(tag)) return 'needs_letter';
  return null;
}

const PROBLEM_TEXT: Record<HashtagProblem, (max: number) => string> = {
  empty: () => 'is empty',
  characters: () => 'may only use letters, numbers and _ (no spaces or punctuation)',
  too_long: (max) => `is longer than ${max} characters`,
  needs_letter: () => 'needs at least one letter',
};

/** Validate and normalise an owner hashtag (no "#"); 400 with `details.problem` otherwise. */
export function validateOwnerHashtag(
  raw: string,
  maxChars: number,
  field: 'primaryHashtag' | 'alwaysHashtags',
): string {
  const problem = hashtagProblem(raw, maxChars);
  if (problem)
    throw new ValidationError(`Hashtag "${raw}" ${PROBLEM_TEXT[problem](maxChars)}`, {
      field,
      problem,
      hashtag: raw,
    });
  return raw.trim().replace(/^#+/, '').normalize('NFC');
}

export function validateBusinessHashtag(raw: string): string {
  return validateOwnerHashtag(raw, BUSINESS_HASHTAG_MAX_CHARS, 'primaryHashtag');
}
