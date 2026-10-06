import type { ContentPlan, ContentPlanItem } from '@prisma/client';
import type { z } from 'zod';
import { isFormatKey, platformsFor, type FormatKey } from '../blitz/formats';
import { projectBodyForCard } from '../blitz/project-body';
import { tiktokPhotoPostsVerified } from '../blitz/targets';
import type { Platform } from './catalog';
import { planTargets } from './content-plans';
import type { createProjectInput } from './projects';

// 22.5 — the project an automation slot becomes (content-plan-run.ts prepareItem calls this for
// plans with an automationId). The slot's format decides what is made (blitz/project-body.ts:
// carousels with the written posts, slideshows with photo slides and dimmed-photo hook / closing
// slides, a 15 s AI video, a UGC video) and where it goes: only the plan's networks that take the
// format (Fastlane: YouTube gets no slideshows or carousels; TikTok carousels only once the slide
// domain is verified — otherwise TikTok gets nothing for that slot and the carousel is "download
// only" there).

type Env = Record<string, string | undefined>;

export function slotPlatforms(
  format: FormatKey,
  planPlatforms: readonly string[],
  env: Env = process.env,
): Platform[] {
  const fitting = platformsFor(format, planPlatforms);
  return format === 'carousel' && !tiktokPhotoPostsVerified(env)
    ? fitting.filter((p) => p !== 'tiktok')
    : fitting;
}

/** Networks of the plan a carousel slot cannot post to automatically (shown as download only). */
export function downloadOnlyPlatforms(
  format: string | null | undefined,
  planPlatforms: readonly string[],
  env: Env = process.env,
): Platform[] {
  if (format !== 'carousel' || tiktokPhotoPostsVerified(env)) return [];
  return planPlatforms.includes('tiktok') ? ['tiktok'] : [];
}

interface SlideText {
  hook: string;
  points: string[];
  cta: string;
}

function slidesOf(item: Pick<ContentPlanItem, 'slides' | 'title'>): SlideText {
  const s = (item.slides ?? {}) as Partial<SlideText>;
  const points = Array.isArray(s.points) ? s.points.filter((p) => typeof p === 'string' && p) : [];
  return {
    hook: typeof s.hook === 'string' && s.hook ? s.hook : item.title,
    points: points.length ? points.slice(0, 6) : [item.title],
    cta: typeof s.cta === 'string' ? s.cta : '',
  };
}

export function automationItemBody(
  plan: Pick<ContentPlan, 'businessId' | 'platforms' | 'language' | 'brandKitId' | 'targets'>,
  item: Pick<ContentPlanItem, 'title' | 'brief' | 'slides' | 'slotAt' | 'format'>,
  shortMaxSec: number,
  env?: Env,
): z.input<typeof createProjectInput> | null {
  if (!isFormatKey(item.format)) return null;
  const format = item.format;
  const platforms = slotPlatforms(format, plan.platforms, env);
  const targets = planTargets(plan).filter((t) => platforms.includes(t.platform));
  const text = slidesOf(item);
  const body = projectBodyForCard(
    format,
    { title: item.title, hook: text.hook, body: text.points, cta: text.cta },
    {
      businessId: plan.businessId,
      language: plan.language,
      brandKitId: plan.brandKitId,
      platforms: platforms.length ? platforms : (plan.platforms as Platform[]),
      durationSec: Math.max(5, Math.min(15, shortMaxSec)),
    },
  );
  // 20.12: with no account to post to, the post is made and saved for review.
  const posting = targets.length > 0;
  return {
    ...body,
    ...(posting
      ? {
          reviewPolicy: 'AUTO_APPROVE' as const,
          publishPolicy: 'SCHEDULED' as const,
          scheduledStartAt: item.slotAt.toISOString(),
          autoPublish: { targets },
        }
      : { reviewPolicy: 'REQUIRE_APPROVAL' as const, publishPolicy: 'MANUAL' as const }),
  };
}
