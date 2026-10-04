import type { Prisma } from '@prisma/client';
import type { PlanTier } from '../providers/router';
import type { PipelineDeps } from './deps';
import { DURATION_TOLERANCE_SEC } from './quality-checks';
import { decideFit, narrationSec, type FitDecision } from './voice-fit';
import { ensureWordTiming, spokenWordsOf } from './word-timing';

// BACKLOG 15.B3 — apply the voice-fit decision (voice-fit.ts) to one shot after Layer 4:
// extend the shot, regenerate the narration faster (once), or trim it at a sentence or word
// boundary. The decision is stored on the narration asset as metadata.fit (the composer reads
// trimSec; the quality gate's audio_sync check reads the whole decision). A trim made here is
// provisional: 21.1's rebalance (narration-rebalance.ts) revisits it before composition, when the
// other shots of the script are measured too.

/** Margin kept inside the ±2 s duration check when shots are extended. */
const EXTEND_MARGIN_SEC = 0.5;

/**
 * Seconds the script may still grow by and stay inside the ±2 s duration check (with
 * EXTEND_MARGIN_SEC kept back). Shared by voice fit's "extend" and 21.1's rebalance.
 */
export function scriptGrowBudgetSec(targetDurationSec: number, shotsTotalSec: number): number {
  return Math.max(
    0,
    targetDurationSec + DURATION_TOLERANCE_SEC - EXTEND_MARGIN_SEC - shotsTotalSec,
  );
}

async function measure(
  deps: PipelineDeps,
  asset: { s3Bucket: string; s3Key: string; metadata: Prisma.JsonValue },
): Promise<{ words: ReturnType<typeof spokenWordsOf>; voiceSec: number | null }> {
  const words = spokenWordsOf(asset.metadata);
  let probed: number | null = null;
  if (words.length === 0) {
    try {
      probed = (await deps.media.probe(await deps.storage.signedUrl(asset.s3Bucket, asset.s3Key)))
        .durationSec;
    } catch (err) {
      deps.logger.warn({ err: (err as Error).message }, 'narration could not be measured');
    }
  }
  return { words, voiceSec: narrationSec(words, probed) };
}

async function storeFit(deps: PipelineDeps, assetId: string, fit: FitDecision): Promise<void> {
  const asset = await deps.db.videoAsset.findUnique({
    where: { id: assetId },
    select: { metadata: true },
  });
  const base =
    asset?.metadata && typeof asset.metadata === 'object' && !Array.isArray(asset.metadata)
      ? (asset.metadata as Record<string, unknown>)
      : {};
  await deps.db.videoAsset.update({
    where: { id: assetId },
    data: { metadata: { ...base, fit: { ...fit } } as Prisma.InputJsonValue },
  });
}

/**
 * Fit the shot's narration. `regenerateFaster(speed)` re-runs TTS at the given rate and returns
 * the new narration asset id (or null when it could not).
 */
export async function fitNarration(
  deps: PipelineDeps,
  input: {
    shotId: string;
    organisationId: string;
    planTier: PlanTier;
    regenerateFaster: (speed: number) => Promise<string | null>;
  },
): Promise<FitDecision | null> {
  const shot = await deps.db.videoShot.findUnique({
    where: { id: input.shotId },
    include: {
      script: { select: { targetDurationSec: true, shots: { select: { durationSec: true } } } },
    },
  });
  if (!shot?.voiceAssetId) return null;
  const routing = (shot.providerRouting as Record<string, unknown> | null) ?? {};
  const voiceRouting = routing.voice as { providerId?: unknown } | undefined;
  const budget = scriptGrowBudgetSec(
    shot.script.targetDurationSec,
    shot.script.shots.reduce((sum, s) => sum + s.durationSec, 0),
  );

  let assetId = shot.voiceAssetId;
  let alreadySped = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const asset = await deps.db.videoAsset.findFirst({
      where: { id: assetId, organisationId: input.organisationId },
    });
    if (!asset) return null;
    const { words, voiceSec } = await measure(deps, asset);
    const decision = decideFit({
      voiceSec,
      shotSec: shot.durationSec,
      treatment: shot.visualTreatment,
      words,
      extendBudgetSec: budget,
      canSpeedUp: voiceRouting?.providerId === 'elevenlabs',
      alreadySped,
    });
    if (decision.strategy === 'speed' && decision.speed) {
      const faster = await input.regenerateFaster(decision.speed);
      if (faster) {
        await ensureWordTiming(deps, {
          assetId: faster,
          organisationId: input.organisationId,
          planTier: input.planTier,
        });
        await storeFit(deps, assetId, decision); // the slower take, for the record
        assetId = faster;
        alreadySped = true;
        continue;
      }
      alreadySped = true;
      continue;
    }
    if (decision.strategy === 'extend' && decision.newShotSec) {
      await deps.db.videoShot.update({
        where: { id: shot.id },
        data: { durationSec: decision.newShotSec },
      });
    }
    const final = alreadySped ? { ...decision, speedApplied: true } : decision;
    await storeFit(deps, assetId, final);
    if (decision.strategy !== 'fits' && decision.strategy !== 'unmeasured')
      deps.logger.info({ shotId: shot.id, fit: final }, 'narration fitted to its shot');
    return final;
  }
  return null;
}
