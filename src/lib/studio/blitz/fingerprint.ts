// 22.4 / 22.5 — "no_unique_content" (Fastlane): a suggestion or automation slot that repeats one
// of the business's last 90 days of suggestions or posts is rejected. The fingerprint is the set
// of meaningful words of the title and hook (lower case, accents folded, short and common words
// dropped), stored as a sorted space-separated string; two fingerprints are near-duplicates when
// their word sets overlap by at least NEAR_DUPLICATE_JACCARD (or are identical).

export const DEDUPE_WINDOW_DAYS = 90;
export const NEAR_DUPLICATE_JACCARD = 0.6;
const MAX_TOKENS = 40;

const STOP = new Set(
  (
    'a an and are as at be but by can do for from get got has have how i if in into is it its ' +
    'just make me more most my no not of on or our out so than that the their them then there ' +
    'these they this to up us was we what when why will with you your yours'
  ).split(' '),
);

export function tokens(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** The fingerprint of a post: its title and hook words, deduplicated and sorted. */
export function fingerprintOf(...parts: Array<string | null | undefined>): string {
  const set = new Set(parts.flatMap((p) => (p ? tokens(p) : [])));
  return [...set].sort().slice(0, MAX_TOKENS).join(' ');
}

export function jaccard(a: string, b: string): number {
  const left = new Set(a.split(' ').filter(Boolean));
  const right = new Set(b.split(' ').filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const w of left) if (right.has(w)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export function isNearDuplicate(candidate: string, existing: readonly string[]): boolean {
  if (!candidate) return false;
  return existing.some((e) => e === candidate || jaccard(candidate, e) >= NEAR_DUPLICATE_JACCARD);
}
