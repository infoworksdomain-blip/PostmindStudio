import type { Prisma, VisualTreatment } from '@prisma/client';
import type { PlanTier } from '../providers/router';
import type { PipelineDeps } from '../pipeline/deps';
import { decideFit, narrationSec, type FitDecision } from '../pipeline/voice-fit';
import { ensureWordTiming, spokenWordsOf } from '../pipeline/word-timing';

// BACKLOG 21.4 — clip-native speech. A UGC_ACTOR shot's visual asset (the actor clip) carries its
// own narration: there is no ElevenLabs voice asset. Every layer that reads "the shot's spoken
// words" goes through speechAssetIdOf():
//   - word timing (13.6): the clip is transcribed like a narration file (AssemblyAI accepts video);
//   - captions (overlays/voice-captions.ts) and karaoke (compose-video.ts) use those words;
//   - the composer plays the clip's own audio (pipeline/edl.ts clipSpeech);
//   - audio_sync (quality-sync.ts) checks the actor's line ends inside its shot, from the fit
//     stored here on the clip asset (metadata.fit, the same shape as a narration's).
// A UGC shot that DEGRADED to narrated B-roll (no actor provider available) has an ordinary voice
// asset and is handled like any narrated shot.

export interface SpeechShot {
  visualTreatment: VisualTreatment | string;
  voiceAssetId: string | null;
  assetId: string | null;
}

/** The shot's picture speaks its own line (an actor clip, not a degraded one). */
export function clipSpeaks(shot: SpeechShot): boolean {
  return shot.visualTreatment === 'UGC_ACTOR' && !shot.voiceAssetId && Boolean(shot.assetId);
}

/** The asset whose audio is the shot's speech: the narration, else a speaking clip. */
export function speechAssetIdOf(shot: SpeechShot): string | null {
  return shot.voiceAssetId ?? (clipSpeaks(shot) ? shot.assetId : null);
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
 * After an actor clip is recorded: transcribe it (once) and store how its speech fits the shot.
 * The clip cannot be re-voiced or re-paced, so the decision is only ever `fits`, `trim` (the line
 * runs past the shot: audio_sync reports it) or `unmeasured`.
 */
export async function timeClipSpeech(
  deps: PipelineDeps,
  input: { shotId: string; organisationId: string; planTier: PlanTier },
): Promise<FitDecision | null> {
  const shot = await deps.db.videoShot.findUnique({
    where: { id: input.shotId },
    select: { visualTreatment: true, voiceAssetId: true, assetId: true, durationSec: true },
  });
  if (!shot || !clipSpeaks(shot) || !shot.assetId) return null;
  await ensureWordTiming(deps, {
    assetId: shot.assetId,
    organisationId: input.organisationId,
    planTier: input.planTier,
  });
  const asset = await deps.db.videoAsset.findFirst({
    where: { id: shot.assetId, organisationId: input.organisationId },
  });
  if (!asset) return null;
  const words = spokenWordsOf(asset.metadata);
  let probed: number | null = null;
  if (words.length === 0) {
    try {
      probed = (await deps.media.probe(await deps.storage.signedUrl(asset.s3Bucket, asset.s3Key)))
        .durationSec;
    } catch (err) {
      deps.logger.warn({ err: (err as Error).message }, 'actor clip could not be measured');
    }
  }
  const fit = decideFit({
    voiceSec: narrationSec(words, probed),
    shotSec: shot.durationSec,
    treatment: 'UGC_ACTOR',
    words,
    extendBudgetSec: 0,
    canSpeedUp: false,
    alreadySped: false,
  });
  await storeFit(deps, asset.id, fit);
  return fit;
}
