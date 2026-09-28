import { ValidationError } from '../../errors';
import type { Platform } from '../services/catalog';
import { PLATFORM_RULES } from './rules';

// Spec 9.8: each platform gets its own caption. The user supplies caption text and hashtags per
// publication; this module normalises hashtags, adds required ones, and enforces the platform's
// length limits. Over-long captions a person typed are rejected (400), never silently truncated.
// 15.A9 (spec 9.3 "CAPTION_TOO_LONG → truncate at 2200 chars, warn user"): captions Studio sends
// on its own (auto-publish, scheduled and drip targets) are cut at a word boundary with
// fitCaption() first and the publication records metadata.captionTruncated — the person is not
// there to fix a 400. DECISION recorded in PROGRESS (Phase 15).

const HASHTAG = /^[\p{L}\p{N}_]{1,100}$/u;

export function normaliseHashtags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().replace(/^#+/, '');
    if (!tag) continue;
    if (!HASHTAG.test(tag))
      throw new ValidationError(`Invalid hashtag "${raw}" (letters, numbers and _ only)`);
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(tag);
    }
  }
  return out;
}

export interface ComposedCaption {
  text: string;
  hashtags: string[];
  title?: string;
}

function lengthOf(text: string, inBytes: boolean): number {
  return inBytes ? Buffer.byteLength(text, 'utf8') : [...text].length;
}

/** YouTube forbids < and > in titles and descriptions. */
function stripAngleBrackets(text: string): string {
  return text.replace(/[<>]/g, '');
}

export function composeCaption(
  platform: Platform,
  input: { caption: string; hashtags: string[]; title?: string },
): ComposedCaption {
  const rules = PLATFORM_RULES[platform];
  const isYouTube = platform === 'youtube' || platform === 'youtube_short';
  const hashtags = normaliseHashtags([...input.hashtags, ...(rules.requiredHashtags ?? [])]);
  if (hashtags.length > rules.maxHashtags + (rules.requiredHashtags?.length ?? 0)) {
    throw new ValidationError(`${platform} allows at most ${rules.maxHashtags} hashtags`);
  }
  let caption = input.caption.trim();
  if (isYouTube) caption = stripAngleBrackets(caption);
  const tagLine = hashtags.map((t) => `#${t}`).join(' ');
  const text = [caption, tagLine].filter(Boolean).join('\n\n');
  if (lengthOf(text, rules.captionLimitInBytes ?? false) > rules.captionMaxChars) {
    throw new ValidationError(
      `${platform} caption is too long (max ${rules.captionMaxChars} ${rules.captionLimitInBytes ? 'bytes' : 'characters'} including hashtags)`,
    );
  }

  let title: string | undefined;
  if (rules.titleMaxChars) {
    const source = stripAngleBrackets((input.title ?? caption.split('\n')[0] ?? '').trim());
    if (!source) throw new ValidationError(`${platform} needs a title`);
    title = [...source].slice(0, rules.titleMaxChars).join('');
  }
  return { text, hashtags, ...(title && { title }) };
}

const ELLIPSIS = '…';

/**
 * 15.A9 — shorten `caption` (at a word boundary, with an ellipsis) so that caption + hashtags fit
 * the platform limit. Returns the caption unchanged when it already fits.
 */
export function fitCaption(
  platform: Platform,
  input: { caption: string; hashtags: string[] },
): { caption: string; truncated: boolean } {
  const rules = PLATFORM_RULES[platform];
  const inBytes = rules.captionLimitInBytes ?? false;
  const isYouTube = platform === 'youtube' || platform === 'youtube_short';
  const hashtags = normaliseHashtags([...input.hashtags, ...(rules.requiredHashtags ?? [])]);
  const tagLine = hashtags.map((t) => `#${t}`).join(' ');
  const clean = isYouTube ? stripAngleBrackets(input.caption.trim()) : input.caption.trim();
  const fits = (caption: string) =>
    lengthOf([caption, tagLine].filter(Boolean).join('\n\n'), inBytes) <= rules.captionMaxChars;
  if (fits(clean)) return { caption: input.caption, truncated: false };
  const chars = [...clean];
  let lo = 0;
  let hi = chars.length;
  // Longest prefix (in code points) that still fits with the ellipsis.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(chars.slice(0, mid).join('') + ELLIPSIS)) lo = mid;
    else hi = mid - 1;
  }
  const prefix = chars.slice(0, lo).join('');
  const space = prefix.search(/\s\S*$/u);
  const cut = (space > prefix.length * 0.6 ? prefix.slice(0, space) : prefix).trimEnd();
  return { caption: cut ? cut + ELLIPSIS : '', truncated: true };
}
