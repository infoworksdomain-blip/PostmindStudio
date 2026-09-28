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
import { normaliseWord, type SpokenWord } from '../overlays/word-timing';

// BACKLOG 15.B2 — gathers what quality-sync.ts needs for one render (its composition summary,
// the shots' narration fit and word timing, spoken-caption overlays, the brand kit) and runs the
// four checks. Called by the quality gate (queue/workers/run-quality-gate.ts).

/** Spoken captions: karaoke overlays and subtitle-group preset overlays (13.5/13.6/15.A4). */
/**
 * Karaoke overlays always follow the narration. A subtitle-group overlay counts as a caption of
 * the voiceover only when most of its words are spoken in the shot; otherwise it is on-screen
 * text (a price, a hook) that is not meant to track speech.
 */
function isSpokenCaption(
  row: { animationIn: string; text: string; presetGroup?: string | null },
  words: SpokenWord[],
): boolean {
  if (row.animationIn === 'karaokeHighlight') return true;
  if (row.presetGroup !== 'subtitle' || words.length === 0) return false;
  const spoken = new Set(words.map((w) => normaliseWord(w.text)));
  const keys = row.text.split(/\s+/).map(normaliseWord).filter(Boolean);
  return keys.length > 0 && keys.filter((k) => spoken.has(k)).length / keys.length >= 0.5;
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
  const voiceIds = shots.map((s) => s.voiceAssetId).filter((id): id is string => Boolean(id));
  const voices = new Map(
    (
      await deps.db.videoAsset.findMany({
        where: { id: { in: voiceIds }, organisationId: input.project.organisationId },
      })
    ).map((a) => [a.id, a]),
  );

  const narration = shots
    .filter((s) => s.voiceAssetId)
    .map((s) => ({
      shotId: s.id,
      fit: fitOf(voices.get(s.voiceAssetId as string)?.metadata ?? null),
    }));

  const presetIds = [...new Set(shots.flatMap((s) => s.overlays.map((o) => o.presetId)))].filter(
    (id): id is string => Boolean(id),
  );
  const presets = presetIds.length
    ? new Map(
        (
          await deps.db.overlayPreset.findMany({
            where: { id: { in: presetIds } },
            select: { id: true, group: true },
          })
        ).map((p) => [p.id, p.group]),
      )
    : new Map<string, string>();
  const captions: SpokenCaption[] = shots.flatMap((shot) => {
    const voice = shot.voiceAssetId ? voices.get(shot.voiceAssetId) : undefined;
    const words = voice ? spokenWordsOf(voice.metadata) : [];
    return shot.overlays
      .filter((o) =>
        isSpokenCaption({ ...o, presetGroup: o.presetId ? presets.get(o.presetId) : null }, words),
      )
      .map((o) => ({
        overlayId: o.id,
        text: o.text,
        startAtSec: o.startAtSec,
        endAtSec: o.endAtSec,
        words,
      }));
  });

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

  return {
    summary,
    checks: [
      evaluateAudioSync(summary, narration),
      evaluateWatermark(summary, expected, sample),
      evaluateCaptionSync(captions),
      evaluateBrandKit(summary, expected),
    ],
  };
}
