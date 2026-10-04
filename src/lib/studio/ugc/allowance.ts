import type { Prisma } from '@prisma/client';
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
export const UGC_VIDEO_ALLOWANCE_UNITS = 2;

/** How many videos of the allowance (or of a pack) a project uses when it is generated. */
export function allowanceUnitsOf(metadata: Prisma.JsonValue | null | undefined): number {
  return ugcStyleOf(metadata) ? UGC_VIDEO_ALLOWANCE_UNITS : 1;
}
