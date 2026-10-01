import type { Platform } from '../services/catalog';
import { normaliseHashtags } from '../platforms/captions';
import { PLATFORM_RULES } from '../platforms/rules';

// 20.13 — which hashtags a post carries (operator request 2026-10-01: "minimum of 5 hashtags,
// 1 of which must be the business hashtag"; owner "always include" hashtags on every post).
// Order: the business hashtag first (so it is one of the three YouTube may show above the
// title, and survives any trimming), then the owner's always-hashtags, then the chosen ones (the
// owner's edits or the AI suggestions), then a top-up from the project's other suggestions and
// the business profile until the minimum is met. De-duplicated case-insensitively (first
// spelling wins); a platform's required tags (#Shorts) are left to composeCaption. Never more
// than the platform's maximum (rules.ts): chosen and top-up tags are trimmed first, then the
// always-hashtags; the business hashtag is never dropped.

export const MIN_HASHTAGS = 5;
/** Suggested (AI / profile) hashtags longer than this are skipped: five always fit X's 280. */
export const SUGGESTED_HASHTAG_MAX_CHARS = 30;

export interface HashtagPolicy {
  /** The business hashtag without "#", or null when the business has none (no name, core mode). */
  business: string | null;
  always: string[];
}

export interface HashtagLimits {
  min: number;
  max: number;
}

export function hashtagLimits(platform: Platform): HashtagLimits {
  const max = PLATFORM_RULES[platform].maxHashtags;
  return { min: Math.min(MIN_HASHTAGS, max), max };
}

/** Keep the valid tags of an untrusted list (AI output, stored data), normalised, no "#". */
export function safeHashtags(tags: readonly unknown[], maxChars = 100): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    try {
      const [clean] = normaliseHashtags([tag]);
      if (clean && [...clean].length <= maxChars) out.push(clean);
    } catch {
      // Punctuation or spaces: dropped rather than failing the whole list.
    }
  }
  return out;
}

export interface AssembledHashtags {
  hashtags: string[];
  /** Business + always-hashtags present in `hashtags` (the owner cannot remove these). */
  locked: string[];
  /** Tags left out because of the platform maximum. */
  dropped: string[];
  /** Tags added from the pool to reach the minimum. */
  toppedUp: string[];
  /** Fewer than the minimum even after the top-up. */
  short: boolean;
  limits: HashtagLimits;
}

export function assembleHashtags(
  platform: Platform,
  input: { policy: HashtagPolicy; chosen: readonly string[]; pool?: readonly string[] },
): AssembledHashtags {
  const limits = hashtagLimits(platform);
  const required = new Set(
    (PLATFORM_RULES[platform].requiredHashtags ?? []).map((t) => t.toLowerCase()),
  );
  const seen = new Set<string>(required);
  const take = (tags: readonly string[]) =>
    tags.filter((tag) => {
      const key = tag.toLowerCase();
      if (!tag || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const locked = take([
    ...(input.policy.business ? [input.policy.business] : []),
    ...input.policy.always,
  ]);
  const chosen = take(input.chosen);
  const keptLocked = locked.slice(0, limits.max);
  const room = limits.max - keptLocked.length;
  const keptChosen = chosen.slice(0, Math.max(0, room));
  const dropped = [...locked.slice(limits.max), ...chosen.slice(Math.max(0, room))];
  const hashtags = [...keptLocked, ...keptChosen];
  const toppedUp: string[] = [];
  if (hashtags.length < limits.min) {
    const pool = take(safeHashtags(input.pool ?? [], SUGGESTED_HASHTAG_MAX_CHARS));
    // On X every character counts: the shortest suggestions leave the most room for the caption.
    const ordered = platform === 'x' ? [...pool].sort((a, b) => a.length - b.length) : pool;
    for (const tag of ordered) {
      if (hashtags.length >= limits.min) break;
      hashtags.push(tag);
      toppedUp.push(tag);
    }
  }
  return {
    hashtags,
    locked: keptLocked,
    dropped,
    toppedUp,
    short: hashtags.length < limits.min,
    limits,
  };
}
