import { deriveBusinessHashtag } from '@/lib/studio/hashtags/business-hashtag';
import { assembleHashtags, type HashtagPolicy } from '@/lib/studio/hashtags/policy';
import type { Platform } from '@/lib/studio/services/catalog';
import { DEMO_BUSINESS_NAME } from './ids';

// 20.13 demo state: the sample business's hashtags (Business → Hashtags) and the rule every
// sample post follows — business hashtag first, the "always" hashtags, then suggestions, at
// least five (the real hashtags/policy.ts). Pure, so seeds and handlers can share it.

export const DEMO_DERIVED_HASHTAG = deriveBusinessHashtag(DEMO_BUSINESS_NAME);

export const demoHashtagSettings = {
  primaryHashtag: null as string | null,
  alwaysHashtags: ['RealBread'],
  updatedAt: null as string | null,
};

export function demoPolicy(): HashtagPolicy {
  return {
    business: demoHashtagSettings.primaryHashtag ?? DEMO_DERIVED_HASHTAG,
    always: demoHashtagSettings.alwaysHashtags,
  };
}

/** Suggestions a Leeds bakery's posts are topped up from. */
export const DEMO_POOL = ['Sourdough', 'LeedsFood', 'BakeryLife', 'Leeds', 'ShopLocal', 'Bread'];

/** A sample post's hashtags under the rule (platform maximum respected). */
export function demoHashtags(chosen: readonly string[], platform: string = 'instagram_reel') {
  return assembleHashtags(platform as Platform, {
    policy: demoPolicy(),
    chosen: chosen.map((t) => t.replace(/^#+/, '')),
    pool: DEMO_POOL,
  }).hashtags;
}
