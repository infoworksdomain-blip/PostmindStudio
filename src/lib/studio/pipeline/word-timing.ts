import type { Prisma } from '@prisma/client';
import {
  CostCapPausedError,
  KillSwitchTriggeredError,
  NoProviderAvailableError,
} from '../../errors';
import type { PlanTier } from '../providers/router';
import { parseSpokenWords, type SpokenWord } from '../overlays/word-timing';
import type { PipelineDeps } from './deps';
import { runProvider } from './provider-run';

// Phase 13.6 — word-level caption timing. After Layer 4 records a shot's narration (or when an
// uploaded video is planned), the audio is transcribed with the existing AssemblyAI adapter
// (providers/assemblyai.ts: POST /v2/transcript { audio_url }, GET /v2/transcript/{id} →
// words[{ text, start, end }] in ms; https://www.assemblyai.com/docs/speech-to-text/pre-recorded-audio/word-level-timestamps,
// read 2026-09-27) and the words are stored on the asset as metadata.wordTiming. Karaoke
// overlays read them at composition (overlays/compose.ts).
//
// 15.C5: the script's language is sent to the transcriber (AssemblyAI language_code, whisper-1
// language), so non-English narration is not transcribed as English.
//
// Non-fatal by design: without timing, karaoke spreads words evenly as before. A cost-cap pause or
// a kill switch still stops the run, like every other provider call.

export type WordTiming =
  | { status: 'ok'; words: SpokenWord[]; providerId: string }
  | { status: 'unavailable' | 'failed'; reason: string };

export function wordTimingOf(metadata: Prisma.JsonValue | null): WordTiming | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).wordTiming;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.status === 'ok')
    return {
      status: 'ok',
      words: parseSpokenWords(v.words),
      providerId: typeof v.providerId === 'string' ? v.providerId : 'unknown',
    };
  if (v.status === 'unavailable' || v.status === 'failed')
    return { status: v.status, reason: typeof v.reason === 'string' ? v.reason : '' };
  return null;
}

/** Spoken words stored on an asset (empty when it was never transcribed or it failed). */
export function spokenWordsOf(metadata: Prisma.JsonValue | null): SpokenWord[] {
  const timing = wordTimingOf(metadata);
  return timing?.status === 'ok' ? timing.words : [];
}

export async function transcribeWords(
  deps: PipelineDeps,
  input: {
    organisationId: string;
    projectId: string;
    planTier: PlanTier;
    mediaUrl: string;
    durationSec: number;
    /** 15.C5: BCP 47 language of the speech (the script's language). */
    languageCode?: string;
  },
): Promise<WordTiming> {
  try {
    const run = await runProvider(
      {
        need: { kind: 'capability', capability: 'transcription' },
        planTier: input.planTier,
        request: {
          capability: 'transcription',
          organisationId: input.organisationId,
          projectId: input.projectId,
          mediaUrl: input.mediaUrl,
          durationSec: Math.max(1, input.durationSec),
          ...(input.languageCode && { languageCode: input.languageCode }),
        },
      },
      deps,
    );
    const metadata = (run.output.metadata ?? {}) as { words?: unknown };
    return {
      status: 'ok',
      words: parseSpokenWords(metadata.words),
      providerId: run.decision.providerId,
    };
  } catch (err) {
    if (err instanceof CostCapPausedError || err instanceof KillSwitchTriggeredError) throw err;
    if (err instanceof NoProviderAvailableError)
      return { status: 'unavailable', reason: 'no transcription provider available' };
    return {
      status: 'failed',
      reason: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    };
  }
}

/**
 * 15.C5: the language spoken in an asset — its shot's script language (video_scripts.language),
 * else the project's language (uploads). Undefined when neither is found.
 */
export async function spokenLanguageOf(
  deps: PipelineDeps,
  asset: { shotId: string | null; projectId: string },
): Promise<string | undefined> {
  if (asset.shotId) {
    const shot = await deps.db.videoShot.findUnique({
      where: { id: asset.shotId },
      select: { script: { select: { language: true } } },
    });
    if (shot?.script.language) return shot.script.language;
  }
  const project = await deps.db.videoProject.findUnique({
    where: { id: asset.projectId },
    select: { language: true },
  });
  return project?.language ?? undefined;
}

/**
 * Transcribe an audio/video asset once and store its word timing on it. An asset that already
 * has a result (any status) is left alone, so a job retry never pays twice.
 */
export async function ensureWordTiming(
  deps: PipelineDeps,
  input: { assetId: string; organisationId: string; planTier: PlanTier },
): Promise<WordTiming | null> {
  const asset = await deps.db.videoAsset.findFirst({
    where: { id: input.assetId, organisationId: input.organisationId },
  });
  if (!asset) return null;
  const existing = wordTimingOf(asset.metadata);
  if (existing) return existing;
  const timing = await transcribeWords(deps, {
    organisationId: input.organisationId,
    projectId: asset.projectId,
    planTier: input.planTier,
    mediaUrl: await deps.storage.signedUrl(asset.s3Bucket, asset.s3Key),
    durationSec: asset.durationSec ?? 1,
    languageCode: await spokenLanguageOf(deps, asset),
  });
  const base =
    asset.metadata && typeof asset.metadata === 'object' && !Array.isArray(asset.metadata)
      ? (asset.metadata as Record<string, unknown>)
      : {};
  await deps.db.videoAsset.update({
    where: { id: asset.id },
    data: { metadata: { ...base, wordTiming: timing } as Prisma.InputJsonValue },
  });
  if (timing.status !== 'ok')
    deps.logger.warn(
      { assetId: asset.id, reason: timing.reason },
      'word timing unavailable; karaoke falls back to even spacing',
    );
  return timing;
}
