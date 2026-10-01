// 20.13 — client-side hashtag helpers for the chip editors. They mirror the server rules
// (src/lib/studio/platforms/captions.ts normaliseHashtags, hashtags/business-hashtag.ts) so the
// editor can say what is wrong before saving; the server checks again.

const TAG_BODY = /^[\p{L}\p{N}_][\p{L}\p{M}\p{N}_]*$/u;
const HAS_LETTER = /\p{L}/u;

export const DEFAULT_TAG_MAX_CHARS = 100;

/** "#Tag" / " tag " → "Tag" (NFC), or null when it is not a valid hashtag. */
export function cleanHashtag(raw: string, maxChars = DEFAULT_TAG_MAX_CHARS): string | null {
  const tag = raw.trim().replace(/^#+/, '').normalize('NFC');
  if (!tag || !TAG_BODY.test(tag) || [...tag].length > maxChars) return null;
  return tag;
}

/** Owner hashtags (business / always) also need a letter. */
export function cleanOwnerHashtag(raw: string, maxChars: number): string | null {
  const tag = cleanHashtag(raw, maxChars);
  return tag && HAS_LETTER.test(tag) ? tag : null;
}

/** Split typed text ("#a b, c") into candidate tags. */
export function splitHashtags(input: string): string[] {
  return input
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.replace(/^#+/, ''));
}

export const sameTag = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function includesTag(list: readonly string[], tag: string): boolean {
  return list.some((t) => sameTag(t, tag));
}

/** Move item `index` by `delta` places (immutable). */
export function moveTag(list: readonly string[], index: number, delta: number): string[] {
  const to = index + delta;
  if (to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item as string);
  return next;
}

/** Locked tags first (in their saved order) when missing, then the rest de-duplicated. */
export function withLocked(value: readonly string[], locked: readonly string[]): string[] {
  const out: string[] = [];
  for (const tag of [...locked.filter((l) => !includesTag(value, l)), ...value])
    if (!includesTag(out, tag)) out.push(tag);
  return out;
}

/** Length of caption + "\n\n" + "#a #b" as the platform counts it (code points or bytes). */
export function composedLength(
  caption: string,
  hashtags: readonly string[],
  inBytes: boolean,
): number {
  const tagLine = hashtags.map((t) => `#${t}`).join(' ');
  const text = [caption.trim(), tagLine].filter(Boolean).join('\n\n');
  return inBytes ? new TextEncoder().encode(text).length : [...text].length;
}
