import type { Prisma } from '@prisma/client';
import {
  isQuickPostSourceType,
  QUARTERS_PER_VIDEO,
  QUICK_POST_QUARTERS,
  VIDEO_QUARTERS,
} from '../billing/allowance-units';
import { ugcStyleOf } from './style';

// BACKLOG 21.4 (operator decision 2026-10-04, per-channel subscriptions): a UGC actor video is
// available to every active subscriber, but it costs us clearly more than an ordinary HD short,
// so it counts as more than one video against the included allowance and the video packs. The
// customer only ever sees "uses 2 of your videos", never a cost.
//
// Arithmetic (list prices, STUDIO_USD_TO_GBP_RATE 0.75; ugc/cost.ts and cost/video-estimate.ts):
//   - an ordinary 30 s HD short on the STANDARD tier (every channel subscription maps to it):
//     ≈ 141p typical (20.25 cost model; up to ≈ £2.20 with regenerations / failover);
//   - a 30 s UGC video: 3 actor clips × 8 s × $0.10/s (Veo 3.1 Fast, audio included) = 180p, plus
//     text, transcription, music and Shotstack ≈ 50p → ≈ 230p; on the Kling fallback ≈ 280p, and a
//     60 s UGC video ≈ 480p;
//   - 230 / 141 ≈ 1.6 and 480 / 220 ≈ 2.2, so one UGC video uses 2 videos.
//
// 23.3 (operator decision 2026-10-06): quick posts — carousels, slideshows, wall of text and
// hook + demo — count as ¼ of a video. Allowance is counted in integer quarters of a video
// (billing/allowance-units.ts).
export const UGC_VIDEO_ALLOWANCE_UNITS = 2;

/** 23.3: what a UGC actor video uses, in quarters of a video. */
export const UGC_VIDEO_QUARTERS = UGC_VIDEO_ALLOWANCE_UNITS * QUARTERS_PER_VIDEO;

function hasObject(metadata: Prisma.JsonValue | null | undefined, key: string): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The project fields the allowance reads. */
export interface AllowanceProject {
  sourceType?: string | null;
  metadata?: Prisma.JsonValue | null;
}

/**
 * 23.3: how many QUARTERS of a video of the allowance (or of a pack) a project uses when it is
 * generated: a UGC actor video UGC_VIDEO_QUARTERS (8), a quick post — carousel (21.6: its posts
 * live in metadata.carousel), slideshow, wall of text (metadata.wallOfText), hook + demo
 * (metadata.hookDemo) — QUICK_POST_QUARTERS (1), any other video VIDEO_QUARTERS (4).
 */
export function allowanceQuartersOf(project: AllowanceProject): number {
  const { metadata, sourceType } = project;
  if (ugcStyleOf(metadata)) return UGC_VIDEO_QUARTERS;
  if (
    isQuickPostSourceType(sourceType) ||
    hasObject(metadata, 'carousel') ||
    hasObject(metadata, 'wallOfText') ||
    hasObject(metadata, 'hookDemo')
  )
    return QUICK_POST_QUARTERS;
  return VIDEO_QUARTERS;
}
