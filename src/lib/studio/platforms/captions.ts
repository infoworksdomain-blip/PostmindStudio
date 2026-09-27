import { ValidationError } from '../../errors';
import type { Platform } from '../services/catalog';
import { PLATFORM_RULES } from './rules';

// Spec 9.8: each platform gets its own caption. The user supplies caption text and hashtags per
// publication; this module normalises hashtags, adds required ones, and enforces the platform's
// length limits. Over-long captions are rejected (400), never silently truncated.

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
