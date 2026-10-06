import { PLAN_CATALOGUE } from '../billing/catalogue';
import { IDEATION_SYSTEM_PROMPT } from '../pipeline/ideation';
import { aiClipBudget, aiClipResolution, AI_CLIP_MAX_SEC } from '../pipeline/clip-budget';
import { SCRIPT_SAFETY_SYSTEM_PROMPT } from '../pipeline/script-safety';
import { SCRIPT_SYSTEM_PROMPT } from '../pipeline/scripting';
import type { AspectRatio, ProviderRequest, VideoResolution } from '../providers/interface';
import type { PlanTier } from '../providers/router';
import type { TextTask } from '../providers/text-tasks';
import { SYSTEM_PROMPT as CAPTION_SYSTEM_PROMPT } from '../services/caption-suggestions';

// BACKLOG 20.25 — the expected provider cost of one video under the AI clip budget, as the list
// of provider requests a typical run makes (the providers each request goes to first). The
// caller prices each request with the adapters' own estimators (the price tables Studio uses for
// budget checks and reservations), so this module holds no prices of its own. The shape follows
// QA run 3 (2026-10-02, a full 30 s TikTok: 10 shots, each narrated, word-timed and voiced on its
// own; one composition; three Layer 1–2 text calls; music on STANDARD and above), with the AI
// clips, their length and resolution set by pipeline/clip-budget.ts.

/** QA run 3 had 10 shots in a 30 s short: one shot per 3 s. */
export const TYPICAL_SHOT_SEC = 3;
/** About 2.5 spoken words a second (SCRIPT_SYSTEM_PROMPT) at ~6 characters a word. */
export const NARRATION_CHARS_PER_SEC = 15;
/**
 * Typical Layer 1–2 output tokens (ideation, one script, the safety verdict, the post copy). The
 * router RESERVES the max-tokens ceiling and settles to the real usage; QA run 3 settled at 7p.
 */
/** 23.2: the post copy is its own light call (it was part of the ideation output). */
export const TYPICAL_TEXT_OUTPUT_TOKENS = {
  ideation: 2_500,
  script: 3_000,
  safety: 300,
  postCopy: 600,
} as const;
/** Brief, brand and format lines in a Layer 1–2 prompt. */
export const TYPICAL_USER_PROMPT_CHARS = 1_200;
/**
 * Image shots that miss the business's library AND stock and are generated (model-chosen
 * IMAGE_STILL only; clip-budget shots never generate). Assumed one per short video.
 */
export const TYPICAL_GENERATED_STILLS_PER_SHORT = 1;

export interface PricedCall {
  providerId: string;
  request: ProviderRequest;
}

export interface TypicalVideoPlan {
  tier: PlanTier;
  durationSec: number;
  aspectRatio: AspectRatio;
  shots: number;
  aiClips: number;
  aiClipSec: number;
  resolution: VideoResolution;
  generatedStills: number;
  music: boolean;
}

/** The typical shape of a video of this length on this tier under the AI clip budget. */
export function typicalVideoPlan(
  tier: PlanTier,
  durationSec: number,
  aspectRatio: AspectRatio = '9:16',
): TypicalVideoPlan {
  const shots = Math.max(1, Math.ceil(durationSec / TYPICAL_SHOT_SEC));
  const aiClips = Math.min(shots, aiClipBudget(tier, durationSec));
  const stills = Math.round((TYPICAL_GENERATED_STILLS_PER_SHORT * durationSec) / 30);
  return {
    tier,
    durationSec,
    aspectRatio,
    shots,
    aiClips,
    aiClipSec: AI_CLIP_MAX_SEC,
    resolution: aiClipResolution(tier),
    generatedStills: Math.min(shots - aiClips, Math.max(0, stills)),
    music: PLAN_CATALOGUE[tier].musicAndSfx,
  };
}

const IDS = { organisationId: 'estimate', projectId: 'estimate' } as const;

function textCall(system: string, maxTokens: number, task: TextTask): PricedCall {
  return {
    providerId: 'anthropic',
    request: {
      ...IDS,
      capability: 'text_generation',
      task,
      system,
      prompt: 'x'.repeat(TYPICAL_USER_PROMPT_CHARS),
      maxTokens,
    },
  };
}

/**
 * 23.2: the Layer 1–2 Claude calls of a one-format run, each with its task (and so its model:
 * ideation and the script on the planning model, safety and post copy on the light one).
 */
export function typicalPlanningCalls(): PricedCall[] {
  return [
    textCall(IDEATION_SYSTEM_PROMPT, TYPICAL_TEXT_OUTPUT_TOKENS.ideation, 'ideation'),
    textCall(SCRIPT_SYSTEM_PROMPT, TYPICAL_TEXT_OUTPUT_TOKENS.script, 'script'),
    textCall(SCRIPT_SAFETY_SYSTEM_PROMPT, TYPICAL_TEXT_OUTPUT_TOKENS.safety, 'script_safety'),
    textCall(CAPTION_SYSTEM_PROMPT, TYPICAL_TEXT_OUTPUT_TOKENS.postCopy, 'post_copy'),
  ];
}

/**
 * The provider requests of a typical run. `aiClipProvider` is the AI_CLIP provider that serves the
 * clips (seedance, the router's first choice; pass kling / veo to price a failover).
 */
export function typicalVideoCalls(
  plan: TypicalVideoPlan,
  aiClipProvider = 'seedance',
): PricedCall[] {
  const shotSec = plan.durationSec / plan.shots;
  const narration = 'x'.repeat(Math.round(shotSec * NARRATION_CHARS_PER_SEC));
  const calls: PricedCall[] = typicalPlanningCalls();
  for (let i = 0; i < plan.aiClips; i += 1) {
    calls.push({
      providerId: aiClipProvider,
      request: {
        ...IDS,
        capability: 'text_to_video',
        prompt: 'scene',
        durationSec: plan.aiClipSec,
        aspectRatio: plan.aspectRatio,
        resolution: plan.resolution,
        planTier: plan.tier,
      },
    });
  }
  for (let i = 0; i < plan.generatedStills; i += 1) {
    calls.push({
      providerId: 'openai',
      request: {
        ...IDS,
        capability: 'text_to_image',
        prompt: 'scene',
        aspectRatio: plan.aspectRatio,
      },
    });
  }
  // Layer 4 voices each shot. 23.2: the narration's word timings come with the speech (ElevenLabs
  // character alignment), so it is no longer transcribed (13.6 used AssemblyAI per shot).
  for (let i = 0; i < plan.shots; i += 1) {
    calls.push({
      providerId: 'elevenlabs',
      request: { ...IDS, capability: 'tts', text: narration, voiceId: 'voice' },
    });
  }
  if (plan.music) {
    calls.push({
      providerId: 'elevenlabs-music',
      request: { ...IDS, capability: 'music', prompt: 'music', durationSec: plan.durationSec },
    });
  }
  calls.push({
    providerId: 'shotstack',
    request: { ...IDS, capability: 'composition', edit: {}, outputDurationSec: plan.durationSec },
  });
  return calls;
}

export interface VideoCostEstimate {
  totalPence: number;
  byProvider: Record<string, number>;
}

/** Sum the calls with `price` (an adapter's estimateCostPence, looked up by provider id). */
export function estimateVideoCostPence(
  calls: readonly PricedCall[],
  price: (call: PricedCall) => number,
): VideoCostEstimate {
  const byProvider: Record<string, number> = {};
  let totalPence = 0;
  for (const call of calls) {
    const pence = price(call);
    byProvider[call.providerId] = (byProvider[call.providerId] ?? 0) + pence;
    totalPence += pence;
  }
  return { totalPence, byProvider };
}
