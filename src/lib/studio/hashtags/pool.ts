import type { Prisma } from '@prisma/client';
import type { Platform } from '../services/catalog';
import { phraseToHashtag } from './business-hashtag';
import { safeHashtags, SUGGESTED_HASHTAG_MAX_CHARS } from './policy';

// 20.13 — where a post's hashtags come from when the chosen ones are not enough for the minimum
// ("top up from business/always/generated tags rather than failing"): the project's generated
// suggestions (this platform first, then the others), the owner's copy for other platforms, the
// brief's keywords, then the business profile (niche, industry, regions, products, audience).

export interface PlatformCopy {
  caption: string;
  hashtags: string[];
  title?: string;
}

type CopyMap = Partial<Record<Platform, PlatformCopy>>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A stored per-platform copy map (metadata.postCopy, captionSuggestions.suggestions, item). */
export function readCopyMap(value: unknown): CopyMap {
  const out: CopyMap = {};
  for (const [platform, raw] of Object.entries(record(value))) {
    const r = record(raw);
    if (typeof r.caption !== 'string') continue;
    out[platform as Platform] = {
      caption: r.caption,
      hashtags: safeHashtags(Array.isArray(r.hashtags) ? r.hashtags : []),
      ...(typeof r.title === 'string' && r.title && { title: r.title }),
    };
  }
  return out;
}

/** The owner's saved copy (metadata.postCopy) and the generated suggestions of a project. */
export function projectCopy(metadata: Prisma.JsonValue | null): {
  owner: CopyMap;
  generated: CopyMap;
} {
  const m = record(metadata);
  return {
    owner: readCopyMap(m.postCopy),
    generated: readCopyMap(record(m.captionSuggestions).suggestions),
  };
}

export interface ProfileWords {
  industry?: string | null;
  subNiche?: string | null;
  regions?: string[];
  products?: string[];
  services?: string[];
  audienceKeywords?: string[];
}

/** Business-profile phrases as hashtags (niche first: the most specific). */
export function profileHashtags(profile: ProfileWords | null | undefined): string[] {
  if (!profile) return [];
  const phrases = [
    profile.subNiche,
    profile.industry,
    ...(profile.regions ?? []).slice(0, 3),
    ...(profile.products ?? []).slice(0, 3),
    ...(profile.services ?? []).slice(0, 2),
    ...(profile.audienceKeywords ?? []).slice(0, 2),
  ];
  return phrases.flatMap((p) => {
    const tag = p ? phraseToHashtag(p, SUGGESTED_HASHTAG_MAX_CHARS) : null;
    return tag ? [tag] : [];
  });
}

export function hashtagPool(
  platform: Platform,
  input: {
    metadata: Prisma.JsonValue | null;
    keywords?: unknown;
    profile?: ProfileWords | null;
  },
): string[] {
  const { owner, generated } = projectCopy(input.metadata);
  const others = (map: CopyMap) =>
    Object.entries(map)
      .filter(([p]) => p !== platform)
      .flatMap(([, c]) => c?.hashtags ?? []);
  const keywords = Array.isArray(input.keywords)
    ? input.keywords.flatMap((k) => {
        const tag = typeof k === 'string' ? phraseToHashtag(k, SUGGESTED_HASHTAG_MAX_CHARS) : null;
        return tag ? [tag] : [];
      })
    : [];
  return [
    ...(generated[platform]?.hashtags ?? []),
    ...others(generated),
    ...others(owner),
    ...keywords,
    ...profileHashtags(input.profile),
  ];
}
