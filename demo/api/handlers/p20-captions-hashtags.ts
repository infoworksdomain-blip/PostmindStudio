// Phase 20.13 sample state — captions and hashtags. The same envelopes as the real routes:
//   GET/PUT /businesses/:id/hashtags          business hashtag (default from the name) + always
//   GET/PUT /projects/:id/post-copy           each platform's caption + hashtags (≥ 5, locked)
// The rules are the real ones (hashtags/business-hashtag.ts, policy.ts, platforms/rules.ts).
import { validateOwnerHashtag } from '@/lib/studio/hashtags/business-hashtag';
import { assembleHashtags, MIN_HASHTAGS } from '@/lib/studio/hashtags/policy';
import { PLATFORM_RULES } from '@/lib/studio/platforms/rules';
import type { Platform } from '@/lib/studio/services/catalog';
import { DEMO_DERIVED_HASHTAG, DEMO_POOL, demoHashtagSettings, demoPolicy } from '../hashtags-data';
import { DemoHttpError, route } from '../registry';
import { getProject, setMeta } from './projects-store';

function settingsView() {
  const s = demoHashtagSettings;
  return {
    primaryHashtag: s.primaryHashtag ?? DEMO_DERIVED_HASHTAG,
    derivedHashtag: DEMO_DERIVED_HASHTAG,
    custom: Boolean(s.primaryHashtag),
    alwaysHashtags: s.alwaysHashtags,
    minHashtags: MIN_HASHTAGS,
    maxChars: 30,
    maxAlways: 10,
    updatedAt: s.updatedAt,
  };
}

function owner(raw: string, field: 'primaryHashtag' | 'alwaysHashtags'): string {
  try {
    return validateOwnerHashtag(raw, 30, field);
  } catch (err) {
    throw new DemoHttpError(400, 'validation_error', (err as Error).message, { field });
  }
}

route('GET', '/businesses/:id/hashtags', () => ({ hashtags: settingsView() }));

route('PUT', '/businesses/:id/hashtags', ({ body }) => {
  const b = (body ?? {}) as { primaryHashtag?: unknown; alwaysHashtags?: unknown };
  const primary =
    typeof b.primaryHashtag === 'string' && b.primaryHashtag.trim()
      ? owner(b.primaryHashtag, 'primaryHashtag')
      : null;
  const always = (Array.isArray(b.alwaysHashtags) ? b.alwaysHashtags : [])
    .filter((t): t is string => typeof t === 'string')
    .map((t) => owner(t, 'alwaysHashtags'));
  demoHashtagSettings.primaryHashtag = primary;
  demoHashtagSettings.alwaysHashtags = [...new Set(always)].slice(0, 10);
  demoHashtagSettings.updatedAt = new Date().toISOString();
  return { hashtags: settingsView() };
});

/** Suggested ("timely, platform-native" — never "trending") copy per platform. */
const SUGGESTED: Record<string, string[]> = {
  tiktok: ['Sourdough', 'BakeryLife', 'Leeds'],
  instagram_reel: ['Sourdough', 'LeedsFood', 'BakeryLife', 'Bread', 'WeekendBake'],
  instagram_feed: ['Sourdough', 'LeedsFood', 'BakeryLife', 'Bread'],
  youtube_short: ['Sourdough', 'Baking', 'Leeds'],
  youtube: ['Sourdough', 'Baking', 'Leeds'],
  linkedin_video: ['SmallBusiness', 'Leeds', 'FoodAndDrink'],
  x: ['Bread', 'Leeds', 'Bake'],
  facebook: ['Leeds', 'Sourdough', 'ShopLocal'],
  facebook_feed: ['Leeds', 'Sourdough', 'ShopLocal'],
};

interface Copy {
  caption: string;
  hashtags: string[];
  title?: string;
}

function ownerCopy(metadata: Record<string, unknown> | null | undefined): Record<string, Copy> {
  const v = metadata?.postCopy;
  return v && typeof v === 'object' ? (v as Record<string, Copy>) : {};
}

function info(platform: Platform, copy: Copy, source: string) {
  const rules = PLATFORM_RULES[platform];
  const assembled = assembleHashtags(platform, {
    policy: demoPolicy(),
    chosen: copy.hashtags,
    pool: source === 'owner' ? [] : DEMO_POOL,
  });
  return {
    caption: copy.caption,
    hashtags: assembled.hashtags,
    ...(copy.title && { title: copy.title }),
    source,
    locked: assembled.locked,
    min: assembled.limits.min,
    max: assembled.limits.max,
    captionMaxChars: rules.captionMaxChars,
    captionLimitInBytes: rules.captionLimitInBytes ?? false,
    required: rules.requiredHashtags ?? [],
    titleMaxChars: rules.titleMaxChars ?? null,
  };
}

route('GET', '/projects/:id/post-copy', ({ params }) => {
  const project = getProject(params.id ?? '');
  const hook = project.brief?.hook ?? project.name ?? '';
  const edits = ownerCopy(project.metadata as Record<string, unknown> | null);
  const platforms = [...new Set(project.renders.map((r) => r.targetPlatform))] as Platform[];
  return {
    platforms: Object.fromEntries(
      platforms.map((p) => {
        const edited = edits[p];
        const copy = edited ?? {
          caption: p === 'x' ? hook.slice(0, 110) : `${hook}\nFresh from our Leeds bakery.`,
          hashtags: SUGGESTED[p] ?? [],
          ...((p === 'youtube' || p === 'youtube_short') && { title: hook.slice(0, 90) }),
        };
        return [p, info(p, copy, edited ? 'owner' : 'generated')];
      }),
    ),
    minHashtags: MIN_HASHTAGS,
  };
});

route('PUT', '/projects/:id/post-copy', ({ params, body }) => {
  const project = getProject(params.id ?? '');
  const b = (body ?? {}) as {
    platform?: string;
    caption?: string;
    hashtags?: unknown;
    title?: string;
  };
  const platform = (b.platform ?? '') as Platform;
  if (!PLATFORM_RULES[platform])
    throw new DemoHttpError(400, 'validation_error', 'Unknown platform');
  const chosen = (Array.isArray(b.hashtags) ? b.hashtags : []).filter(
    (t): t is string => typeof t === 'string',
  );
  const assembled = assembleHashtags(platform, { policy: demoPolicy(), chosen });
  if (assembled.short)
    throw new DemoHttpError(
      400,
      'validation_error',
      `${platform} posts need at least ${assembled.limits.min} hashtags, including the business hashtag`,
      { code: 'hashtags_minimum' },
    );
  if (assembled.dropped.length)
    throw new DemoHttpError(
      400,
      'validation_error',
      `${platform} allows at most ${assembled.limits.max} hashtags`,
      {
        code: 'hashtags_maximum',
      },
    );
  const copy: Copy = {
    caption: (b.caption ?? '').trim(),
    hashtags: assembled.hashtags,
    ...(b.title?.trim() && { title: b.title.trim() }),
  };
  setMeta(project, {
    postCopy: {
      ...ownerCopy(project.metadata as Record<string, unknown> | null),
      [platform]: copy,
    },
  });
  return { copy: info(platform, copy, 'owner'), scheduledUpdated: 0 };
});
