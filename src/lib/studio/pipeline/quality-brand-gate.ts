import type { VideoRender } from '@prisma/client';
import { scriptOf } from '../i18n/scripts';
import { uploadedFontId, resolveProjectBrandKit } from './brand-resolve';
import { parseCompositionSummary, type CompositionSummary } from './composition-summary';
import type { PipelineDeps } from './deps';
import type { QualityCheck } from './quality-checks';
import {
  evaluateAudioSync,
  evaluateBrandKit,
  evaluateCaptionSync,
  evaluateWatermark,
  type BrandExpectation,
  type SpokenCaption,
  type WatermarkSample,
} from './quality-sync';
import { sampleWatermark } from './quality-watermark';
import { fitOf } from './voice-fit';
import { spokenWordsOf } from './word-timing';
import type { SpokenWord } from '../overlays/word-timing';
import { mirrorsNarration } from '../overlays/kind';
import { speechAssetIdOf } from '../ugc/clip-speech';
import { clipTextOf, evaluateClipText } from '../ugc/clip-text-guard';

// BACKLOG 15.B2 — gathers what quality-sync.ts needs for one render (its composition summary,
// the shots' narration fit and word timing, spoken-caption overlays, the brand kit) and runs the
// four checks. Called by the quality gate (queue/workers/run-quality-gate.ts).

/**
 * 20.22: caption_sync judges only overlays that mirror the voice-over — narration captions
 * (text_overlays.kind = 'caption', written by overlays/voice-captions.ts) and karaoke overlays.
 * It used to guess from the preset group and the share of spoken words, which held headline
 * overlays on the subtitle_box preset (suggested for body shots) to the narration and ignored
 * TikTok's narration captions (styled with the hook_tiktok_native preset): QA run 3 failed on
 * "Meeting panic mode" / "AheadAI to the rescue" ("words not found in the narration").
 */
export function spokenCaptions(
  shots: Array<{
    overlays: Array<{
      id: string;
      kind: string;
      animationIn: string;
      text: string;
      startAtSec: number;
      endAtSec: number;
    }>;
    words: SpokenWord[];
  }>,
): SpokenCaption[] {
  return shots.flatMap((shot) =>
    shot.overlays.filter(mirrorsNarration).map((o) => ({
      overlayId: o.id,
      text: o.text,
      startAtSec: o.startAtSec,
      endAtSec: o.endAtSec,
      words: shot.words,
    })),
  );
}

export interface RenderSyncResult {
  checks: QualityCheck[];
  summary: CompositionSummary | null;
}

export async function renderSyncChecks(
  deps: PipelineDeps,
  input: {
    render: VideoRender;
    renderUrl: string;
    renderWidth: number;
    project: { organisationId: string; businessId: string; brandKitId: string | null };
  },
): Promise<RenderSyncResult> {
  const summary = parseCompositionSummary(input.render.composition);
  const script = await deps.db.videoScript.findUnique({
    where: { id: input.render.scriptId },
    include: {
      shots: { orderBy: { sortOrder: 'asc' }, include: { overlays: true } },
    },
  });
  const shots = script?.shots ?? [];
  // 21.4: a UGC actor clip's own audio is its speech (ugc/clip-speech.ts).
  const voiceIds = shots.map(speechAssetIdOf).filter((id): id is string => Boolean(id));
  const voices = new Map(
    (
      await deps.db.videoAsset.findMany({
        where: { id: { in: voiceIds }, organisationId: input.project.organisationId },
      })
    ).map((a) => [a.id, a]),
  );

  const narration = shots.flatMap((s) => {
    const speech = speechAssetIdOf(s);
    return speech ? [{ shotId: s.id, fit: fitOf(voices.get(speech)?.metadata ?? null) }] : [];
  });

  const captions = spokenCaptions(
    shots.map((shot) => {
      const speech = speechAssetIdOf(shot);
      const voice = speech ? voices.get(speech) : undefined;
      return { overlays: shot.overlays, words: voice ? spokenWordsOf(voice.metadata) : [] };
    }),
  );

  const kit = await resolveProjectBrandKit(deps.db, input.project);
  const palette = Array.isArray(kit?.colourPalette)
    ? (kit.colourPalette as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];
  const latin = scriptOf(script?.language) === 'latin';
  let fontFamily: string | null = null;
  if (kit?.fontPrimary && latin) {
    const uploaded = uploadedFontId(kit.fontPrimary);
    fontFamily = uploaded
      ? ((
          await deps.db.videoUpload.findFirst({
            where: { id: uploaded, organisationId: input.project.organisationId },
            select: { fontFamily: true },
          })
        )?.fontFamily ?? null)
      : kit.fontPrimary;
  }
  const expected: BrandExpectation = {
    hasKit: Boolean(kit),
    logo: Boolean(kit?.logoAssetId),
    watermark: Boolean(kit?.watermarkAssetId),
    fontFamily,
    backgroundColour: palette[0],
    textColour: palette[1],
  };

  let sample: WatermarkSample | null = null;
  if (expected.watermark && summary?.brand.watermark && kit?.watermarkAssetId) {
    const upload = await deps.db.videoUpload.findFirst({
      where: { id: kit.watermarkAssetId, organisationId: input.project.organisationId },
    });
    if (!upload) sample = { status: 'unavailable', reason: 'watermark upload not found' };
    else {
      const size = await deps.storage.size(upload.s3Bucket, upload.s3Key);
      const image = await deps.storage.readRange(upload.s3Bucket, upload.s3Key, 0, size - 1);
      sample = await sampleWatermark({
        media: deps.media,
        renderUrl: input.renderUrl,
        renderWidth: input.renderWidth,
        summary,
        watermarkImage: image,
      });
    }
  }

  // 21.4c: actor clips kept with burned-in text (ugc/clip-text-guard.ts) need a person's review.
  const clipText = await clipTextCheck(deps, input.project.organisationId, shots);

  return {
    summary,
    checks: [
      evaluateAudioSync(summary, narration),
      evaluateWatermark(summary, expected, sample),
      evaluateCaptionSync(captions),
      evaluateBrandKit(summary, expected),
      ...(clipText ? [clipText] : []),
    ],
  };
}

async function clipTextCheck(
  deps: PipelineDeps,
  organisationId: string,
  shots: ReadonlyArray<{ visualTreatment: string; assetId: string | null }>,
): Promise<QualityCheck | null> {
  const actorShots = shots
    .map((shot, index) => ({ shot, number: index + 1 }))
    .filter(({ shot }) => shot.visualTreatment === 'UGC_ACTOR' && shot.assetId);
  if (actorShots.length === 0) return null;
  const assets = new Map(
    (
      await deps.db.videoAsset.findMany({
        where: {
          id: { in: actorShots.map(({ shot }) => shot.assetId as string) },
          organisationId,
        },
        select: { id: true, metadata: true },
      })
    ).map((a) => [a.id, a.metadata]),
  );
  return evaluateClipText(
    actorShots.map(({ shot, number }) => ({
      number,
      clipText: clipTextOf(assets.get(shot.assetId as string)),
    })),
  );
}
