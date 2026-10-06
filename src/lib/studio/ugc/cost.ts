import { PLAN_CATALOGUE } from '../billing/catalogue';
import type { PricedCall } from '../cost/video-estimate';
import { typicalPlanningCalls } from '../cost/video-estimate';
import type { AspectRatio } from '../providers/interface';
import type { PlanTier } from '../providers/router';
import { ACTOR_CLIP_SECONDS_WITH_PRODUCT, actorClipBudget } from './plan';
import { PORTRAIT_ASPECT } from './prompt';

// BACKLOG 21.4 — what one UGC actor video costs at list price, and its default project budget.
// The shape of a typical 30 s UGC short (ugc/plan.ts): the tier's actor clips at 8 s each (the
// product image is a reference, so Veo renders 8 s), a product still or closing card in the gap
// (no paid generation), each clip transcribed once for captions (no ElevenLabs voice), four
// Layer 1–2 text calls, music (STANDARD and above) and one composition. Prices come from the
// adapters' own estimators (cost/video-estimate.ts estimateVideoCostPence).
//
// Arithmetic (STUDIO_USD_TO_GBP_RATE 0.75; the test also holds at 0.79), 30 s, Veo 3.1 Fast at
// $0.10/s (audio included, https://ai.google.dev/gemini-api/docs/pricing, read 2026-10-04):
//   STANDARD: 3 clips × 8 s = 24 s × $0.10 = $2.40 → 180p; + text, transcription, music and
//             Shotstack ≈ 50p → ≈ 230p a video.
//   PLUS:     the same 3 × 8 s in a 30 s short with a product image (a fourth 8 s clip would not fit;
//             ugc/plan.ts), 4 × 6 s = 24 s without one; 60 s: 7 × 8 s = 56 s × $0.10 → 420p + ≈ 60p.
//   Kling 3.0 with native audio as the fallback: $0.126/s, 24 s → $3.02 → 227p (+ ≈ 50p).
// Default budget = 2.5 × the typical cost (the 20.25 rule, cost/project-budget.ts), rounded up to
// 50p: STANDARD £6.00 (2.5 × 230p = 575p), PLUS / ENTERPRISE £7.50 (PLUS allows longer UGC videos
// with more clips: a 45 s one is 5 × 8 s = 40 s → 300p + ≈ 55p). A normal UGC video uses ≈ 40% of it, so a
// regenerated clip or the dearer Kling failover never reaches the 90% pause.

export const UGC_BUDGET_PENCE: Readonly<Record<PlanTier, number>> = {
  BASIC: 600, // never used: UGC is STANDARD and above (tier-gates 'video.ugc')
  STANDARD: 600,
  PLUS: 750,
  ENTERPRISE: 750,
};

/** The project budget when the owner sets none (POST /projects with `ugc`). */
export function ugcProjectBudgetPence(tier: PlanTier): number {
  return UGC_BUDGET_PENCE[tier];
}

const IDS = { organisationId: 'estimate', projectId: 'estimate' } as const;

/** The provider requests of a typical UGC run (`actorProvider`: veo, or kling to price failover). */
export function typicalUgcVideoCalls(
  tier: PlanTier,
  durationSec = 30,
  actorProvider = 'veo',
  aspectRatio: AspectRatio = '9:16',
): PricedCall[] {
  const clipSec = ACTOR_CLIP_SECONDS_WITH_PRODUCT[0];
  const clips = Math.min(actorClipBudget(tier, durationSec), Math.floor(durationSec / clipSec));
  const calls: PricedCall[] = [
    // 23.2: ideation, script, safety and post copy, each on its task's model.
    ...typicalPlanningCalls(),
    // 21.4a: the actor portrait, once per project (ugc/portrait.ts; OpenAI's estimate is spec 6.5's
    // 4p a still; the charged cost is recorded from its reported usage).
    {
      providerId: 'openai',
      request: {
        ...IDS,
        capability: 'text_to_image',
        prompt: 'actor portrait',
        aspectRatio: PORTRAIT_ASPECT,
      },
    },
  ];
  for (let i = 0; i < clips; i += 1) {
    calls.push({
      providerId: actorProvider,
      request: {
        ...IDS,
        capability: 'actor_video',
        prompt: 'creator review',
        spokenLine: 'This changed my mornings.',
        languageCode: 'en-GB',
        durationSec: clipSec,
        aspectRatio,
        productImageUrl: 'https://estimate.invalid/product.png',
        seed: 1,
        planTier: tier,
      },
    });
    calls.push({
      providerId: 'assemblyai',
      request: {
        ...IDS,
        capability: 'transcription',
        mediaUrl: 'https://estimate.invalid/clip.mp4',
        durationSec: clipSec,
      },
    });
  }
  if (PLAN_CATALOGUE[tier].musicAndSfx) {
    calls.push({
      providerId: 'elevenlabs-music',
      request: { ...IDS, capability: 'music', prompt: 'music', durationSec },
    });
  }
  calls.push({
    providerId: 'shotstack',
    request: { ...IDS, capability: 'composition', edit: {}, outputDurationSec: durationSec },
  });
  return calls;
}
