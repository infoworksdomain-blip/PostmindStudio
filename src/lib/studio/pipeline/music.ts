import { z } from 'zod';
import { ConfigurationError, ProviderError } from '../../errors';
import { MAX_MUSIC_SEC, MIN_MUSIC_SEC } from '../providers/elevenlabs-music';
import { minTierFor, tierAtLeast } from '../billing/catalogue';
import type { PlanTier } from '../providers/router';
import type { PipelineDeps } from './deps';
import { buildMusicPrompt, type MusicPromptInput } from './music-prompt';
import { fallbackLibraryTrack, musicFailureHandling } from './music-fallback';
import {
  addToLibrary,
  LIBRARY_SOURCE_PROVIDERS,
  musicBucketSec,
  pickLibraryTrack,
} from './music-library';
import { libraryTrackAsset } from './music-library-asset';
import { mergeProjectMetadata } from './project-state';
import { runProvider } from './provider-run';

// Layer 5 — background music, once per run (spec 5.6), before composition.
//
// DECISIONS (flag for review):
//   - Tier gating (spec 12.4): the tier table lists no music provider for Basic (Fal lite +
//     D-ID + Azure Speech), so BASIC renders stay narration-only. Standard's column names no
//     music provider either, but the spec's own 30 s short costing (12.2) includes a track and
//     the planned Storyblocks library pick is not built, so STANDARD and above get a generated
//     track. The minimum tier is STUDIO_MUSIC_MIN_TIER (default STANDARD).
//   - Non-fatal: any music failure (no provider configured, provider error, over budget for
//     this one call) falls back to a music-library track (25.x, music-fallback.ts: status
//     'reused' with fallbackFrom = the failure; not with STUDIO_MUSIC_LIBRARY=off); only with no
//     usable library track does the video
//     render without music, recording metadata.music = { status: 'failed', reason }.
//     CostCapPausedError and KillSwitchTriggeredError are NOT swallowed: a paused budget or an
//     engaged kill switch stops the whole run, as for any other provider call (spec 12.5). Nor is
//     RateDeferredError (25.x): a full ElevenLabs Music slot (2 concurrent, provider-
//     concurrency.ts) delays the compose job until a slot frees, then the track is generated.
//   - 25.x: a retry of the same run reuses the asset that run already recorded (generated,
//     reused or fallback), so a retried job never picks or pays for a second track.
//   - One track per run, sized to the longest variant; each variant's clip trims it
//     (Shotstack AudioAsset: "The audio will play until the file ends or the Clip length is
//     reached"). Reuse: a stored AUDIO_MUSIC asset of this project with the same prompt key
//     and at least the needed length is reused (re-render, retry, regenerate with same tone),
//     so a track is never paid for twice.
//   - 23.1: across videos, a platform music library (music-library.ts) keyed by prompt key and
//     duration bucket: once a key has STUDIO_MUSIC_LIBRARY_SIZE tracks (default 5) a video reuses
//     the least recently used one (metadata.music.status 'reused', no provider call, cost 0);
//     until then it generates at the bucket's full length and adds the track. Studio has no
//     brand-kit music override or business music upload today; upload videos keep their own
//     soundtrack (compose-video never asks for music for them).

/** Phase 18 §P.3: from the plan catalogue (STUDIO_MUSIC_MIN_TIER still overrides). */
export const DEFAULT_MUSIC_MIN_TIER: PlanTier = minTierFor('musicAndSfx');
const LONG_FORM_SEC = 60;
const REASON_MAX = 300;

/** 23.1: 'reused' = a track from the music library (music-library.ts), no provider call. */
export type MusicStatus = 'generated' | 'reused' | 'off_for_plan' | 'failed';

export interface MusicMetadata {
  status: MusicStatus;
  runId: string;
  assetId?: string;
  providerId?: string;
  /** 23.1: the music library track used (reused) or added (generated). */
  libraryTrackId?: string;
  /** 23.1: provider cost of this run's music (0 when reused). */
  costPence?: number;
  durationSec?: number;
  reused?: boolean;
  promptKey?: string;
  descriptors?: ReturnType<typeof buildMusicPrompt>['descriptors'];
  planTier?: PlanTier;
  reason?: string;
  /** 25.x: status 'reused' because generation failed with this reason (library fallback). */
  fallbackFrom?: string;
}

export function parseMusicMinTier(raw: string | undefined): PlanTier {
  const value = raw?.trim().toUpperCase();
  if (!value) return DEFAULT_MUSIC_MIN_TIER;
  if (value === 'BASIC' || value === 'STANDARD' || value === 'PLUS' || value === 'ENTERPRISE')
    return value;
  throw new ConfigurationError('STUDIO_MUSIC_MIN_TIER must be BASIC, STANDARD, PLUS or ENTERPRISE');
}

export function musicAllowedForTier(tier: PlanTier, minTier: PlanTier): boolean {
  return tierAtLeast(tier, minTier);
}

/** Length to request: the video length within the provider's documented 3 s – 5 min. */
export function musicRequestSec(videoSec: number): number {
  return Math.min(MAX_MUSIC_SEC, Math.max(MIN_MUSIC_SEC, Math.ceil(videoSec)));
}

const referenceEnvelope = z
  .object({
    bpm: z.number().nullable().optional(),
    energy: z.string().nullable().optional(),
    mood: z.string().nullable().optional(),
    genre: z.string().nullable().optional(),
  })
  .passthrough();

interface MusicProject {
  id: string;
  organisationId: string;
  sourceType: string;
  referenceVideoId: string | null;
  referenceMode: 'TEMPLATE' | 'INSPIRE' | null;
  metadata: unknown;
}

async function promptInput(
  deps: PipelineDeps,
  project: MusicProject,
  kit: { toneKeywords: string[] } | null,
  videoSec: number,
): Promise<MusicPromptInput> {
  const brief = await deps.db.videoBrief.findUnique({
    where: { projectId: project.id },
    select: { tone: true },
  });
  const meta = (project.metadata ?? {}) as { slideshow?: { templateId?: string | null } };
  const templateId = project.sourceType === 'SLIDESHOW' ? meta.slideshow?.templateId : null;
  const template = templateId
    ? await deps.db.slideshowTemplate.findFirst({
        where: {
          id: templateId,
          OR: [{ organisationId: null }, { organisationId: project.organisationId }],
        },
        select: { musicMood: true },
      })
    : null;
  let reference: MusicPromptInput['reference'] = null;
  if (
    project.sourceType === 'LIBRARY_REFERENCE' &&
    project.referenceVideoId &&
    project.referenceMode
  ) {
    // Only descriptors of the reference's audio are used, never its audio (A3.10).
    const analysis = await deps.db.videoLibraryAnalysis.findFirst({
      where: { libraryItemId: project.referenceVideoId },
      select: { musicEnvelope: true },
    });
    const env = referenceEnvelope.safeParse(analysis?.musicEnvelope);
    if (env.success) {
      reference = {
        mode: project.referenceMode,
        mood: env.data.mood ?? null,
        genre: env.data.genre ?? null,
        energy: env.data.energy ?? null,
        bpm: env.data.bpm ?? null,
      };
    }
  }
  return {
    briefTone: brief?.tone ?? null,
    brandToneKeywords: kit?.toneKeywords ?? [],
    slideshowMusicMood: template?.musicMood ?? null,
    reference,
    format: videoSec > LONG_FORM_SEC ? 'long' : 'short',
  };
}

async function record(deps: PipelineDeps, projectId: string, music: MusicMetadata) {
  await mergeProjectMetadata(deps.db, { projectId, runId: music.runId, patch: { music } });
}

/** 25.x: the track this run already recorded (a retried compose job), if its asset is there. */
async function sameRunTrack(
  deps: PipelineDeps,
  project: MusicProject,
  runId: string,
): Promise<StoredTrack | null> {
  const recorded = (project.metadata as { music?: Partial<MusicMetadata> } | null)?.music;
  if (recorded?.runId !== runId || typeof recorded.assetId !== 'string') return null;
  const asset = await deps.db.videoAsset.findFirst({
    where: {
      id: recorded.assetId,
      projectId: project.id,
      organisationId: project.organisationId,
      kind: 'AUDIO_MUSIC',
    },
  });
  if (!asset) return null;
  const durationSec = asset.durationSec ?? recorded.durationSec ?? 0;
  return { bucket: asset.s3Bucket, key: asset.s3Key, durationSec };
}

function reasonOf(err: unknown): string {
  if (err instanceof ProviderError) return `${err.providerId} ${err.errorClass}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Produce (or reuse) the run's music track. Returns the asset to lay under the edit, or null
 * for no music. Never throws for music problems (a failed generation falls back to the music
 * library, 25.x); CostCapPausedError, KillSwitchTriggeredError and RateDeferredError propagate.
 */
export async function produceMusic(
  deps: PipelineDeps,
  input: {
    project: MusicProject;
    runId: string;
    planTier: PlanTier;
    videoSec: number;
    kit: { toneKeywords: string[] } | null;
  },
): Promise<{ bucket: string; key: string; durationSec: number } | null> {
  const { project, runId, planTier } = input;
  const log = deps.logger.child({ projectId: project.id, runId, layer: 'music' });
  const minTier = deps.config.musicMinTier ?? DEFAULT_MUSIC_MIN_TIER;
  if (!musicAllowedForTier(planTier, minTier)) {
    await record(deps, project.id, { status: 'off_for_plan', runId, planTier });
    return null;
  }
  const requestSec = musicRequestSec(input.videoSec);
  let built: ReturnType<typeof buildMusicPrompt> | undefined;
  try {
    const again = await sameRunTrack(deps, project, runId);
    if (again) return again;
    built = buildMusicPrompt(await promptInput(deps, project, input.kit, input.videoSec));
    const existing = await deps.db.videoAsset.findFirst({
      where: {
        projectId: project.id,
        organisationId: project.organisationId,
        kind: 'AUDIO_MUSIC',
        fingerprint: built.key,
        durationSec: { gte: requestSec },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      await record(deps, project.id, {
        status: 'generated',
        runId,
        assetId: existing.id,
        providerId: existing.source.split(':')[0],
        durationSec: existing.durationSec ?? requestSec,
        reused: true,
        promptKey: built.key,
        descriptors: built.descriptors,
      });
      return {
        bucket: existing.s3Bucket,
        key: existing.s3Key,
        durationSec: existing.durationSec ?? requestSec,
      };
    }

    // 23.1: a track from the music library when the key already has enough of them.
    const library = deps.config.musicLibrary?.enabled ? deps.config.musicLibrary : undefined;
    const bucketSec = library ? musicBucketSec(requestSec) : requestSec;
    if (library) {
      const reused = await reuseLibraryTrack(deps, {
        project,
        runId,
        built,
        bucketSec,
        size: library.size,
      });
      if (reused) return reused;
    }
    return await generateTrack(deps, { project, runId, planTier, built, requestSec, bucketSec });
  } catch (err) {
    // A paused budget or an engaged kill switch stops the whole run, like any provider call;
    // a full provider slot or rate window delays the job (25.x).
    if (musicFailureHandling(err) === 'rethrow') throw err;
    const reason = reasonOf(err).slice(0, REASON_MAX);
    // STUDIO_MUSIC_LIBRARY=off keeps the library out of every video, fallback included.
    const fallback = deps.config.musicLibrary?.enabled
      ? await fallbackLibraryTrack(deps, { project, built, requestSec, reason })
      : null;
    if (fallback) {
      log.info({ reason, match: fallback.match }, 'music failed; library track used instead');
      await record(deps, project.id, {
        status: 'reused',
        runId,
        assetId: fallback.assetId,
        providerId: 'music-library',
        libraryTrackId: fallback.libraryTrackId,
        costPence: 0,
        durationSec: fallback.stored.durationSec,
        reused: true,
        fallbackFrom: reason,
        ...(built && { promptKey: built.key, descriptors: built.descriptors }),
      });
      return fallback.stored;
    }
    log.warn(
      { reason },
      'music failed and the music library has no track; rendering without music',
    );
    await record(deps, project.id, {
      status: 'failed',
      runId,
      reason,
      ...(built && { promptKey: built.key }),
    });
    return null;
  }
}

type BuiltPrompt = ReturnType<typeof buildMusicPrompt>;
type StoredTrack = { bucket: string; key: string; durationSec: number };

/** 23.1: the next library track for the key as this project's music asset (no provider call). */
async function reuseLibraryTrack(
  deps: PipelineDeps,
  input: {
    project: MusicProject;
    runId: string;
    built: BuiltPrompt;
    bucketSec: number;
    size: number;
  },
): Promise<StoredTrack | null> {
  const { project, built } = input;
  const track = await pickLibraryTrack(deps, {
    promptKey: built.key,
    bucketSec: input.bucketSec,
    size: input.size,
  });
  if (!track) return null;
  const asset = await libraryTrackAsset(deps, { project, track, fingerprint: built.key, built });
  if (!asset) return null;
  await record(deps, project.id, {
    status: 'reused',
    runId: input.runId,
    assetId: asset.id,
    providerId: 'music-library',
    libraryTrackId: track.id,
    costPence: 0,
    durationSec: track.durationSec,
    reused: true,
    promptKey: built.key,
    descriptors: built.descriptors,
  });
  return { bucket: track.s3Bucket, key: track.s3Key, durationSec: track.durationSec };
}

/** Generate the run's track (Layer 5 as before 23.1) and, with the library on, add it there. */
async function generateTrack(
  deps: PipelineDeps,
  input: {
    project: MusicProject;
    runId: string;
    planTier: PlanTier;
    built: BuiltPrompt;
    requestSec: number;
    /** = requestSec without the library; the bucket's full length with it. */
    bucketSec: number;
  },
): Promise<StoredTrack> {
  const { project, runId, planTier, built } = input;
  const requestSec = input.bucketSec;
  const run = await runProvider(
    {
      need: { kind: 'capability', capability: 'music' },
      planTier,
      request: {
        capability: 'music',
        organisationId: project.organisationId,
        projectId: project.id,
        prompt: built.prompt,
        durationSec: requestSec,
      },
    },
    deps,
  );
  const meta = (run.output.metadata ?? {}) as {
    s3Bucket?: unknown;
    s3Key?: unknown;
    bytes?: unknown;
    durationSec?: unknown;
    model?: unknown;
  };
  if (typeof meta.s3Bucket !== 'string' || typeof meta.s3Key !== 'string') {
    throw new ProviderError(run.decision.providerId, 'unknown', 'Music had no stored file', false);
  }
  const durationSec = typeof meta.durationSec === 'number' ? meta.durationSec : requestSec;
  const job = await deps.db.providerJob.findUnique({
    where: { id: run.providerJobRowId },
    select: { costPence: true },
  });
  const asset = await deps.db.videoAsset.create({
    data: {
      organisationId: project.organisationId,
      projectId: project.id,
      shotId: null,
      kind: 'AUDIO_MUSIC',
      source: `${run.decision.providerId}${typeof meta.model === 'string' ? `:${meta.model}` : ''}`,
      s3Bucket: meta.s3Bucket,
      s3Key: meta.s3Key,
      durationSec,
      fileSizeBytes: typeof meta.bytes === 'number' ? BigInt(meta.bytes) : null,
      fingerprint: built.key,
      providerJobId: run.providerJobRowId,
      costPence: job?.costPence ?? 0,
      metadata: { prompt: built.prompt, descriptors: built.descriptors },
    },
  });
  const added = (await libraryContribution(deps, project, run.decision.providerId))
    ? await addToLibrary(
        {
          db: deps.db,
          storage: deps.storage,
          logger: deps.logger,
          bucket: deps.config.assetsBucket,
        },
        {
          promptKey: built.key,
          bucketSec: input.bucketSec,
          durationSec,
          from: { bucket: asset.s3Bucket, key: asset.s3Key },
          source: asset.source,
          providerJobId: run.providerJobRowId,
          costPence: asset.costPence,
        },
      )
    : null;
  await record(deps, project.id, {
    status: 'generated',
    runId,
    assetId: asset.id,
    providerId: run.decision.providerId,
    durationSec,
    reused: false,
    promptKey: built.key,
    descriptors: built.descriptors,
    ...(added && { libraryTrackId: added.id }),
  });
  return { bucket: asset.s3Bucket, key: asset.s3Key, durationSec };
}

/**
 * 23.1: a generation joins the library only when the library is on, it is generated music we
 * own (ElevenLabs Music, not a Storyblocks pick) and it ran on the platform account (not a BYOC
 * organisation's own keys).
 */
async function libraryContribution(
  deps: PipelineDeps,
  project: MusicProject,
  providerId: string,
): Promise<boolean> {
  if (!deps.config.musicLibrary?.enabled || !LIBRARY_SOURCE_PROVIDERS.has(providerId)) return false;
  const own = await deps.registryFor?.({
    organisationId: project.organisationId,
    projectId: project.id,
  });
  return own === undefined;
}
