import type { AssetKind, Prisma, VideoShot } from '@prisma/client';
import { ConfigurationError, NotFoundError, ValidationError } from '../../../errors';
import {
  avatarUnavailableReason,
  DEGRADED_FROM_ACTOR,
  DEGRADED_FROM_AVATAR,
  degradedClipDurationSec,
  degradedClipPrompt,
} from '../../pipeline/avatar-fallback';
import type { AspectRatio } from '../../providers/interface';
import { providerOutputKey } from '../../storage';
import type { PipelineDeps } from '../../pipeline/deps';
import { copyUrlToStorage } from '../../pipeline/persist';
import { currentRunId, transitionProject } from '../../pipeline/project-state';
import { runProvider, type ProviderRunResult } from '../../pipeline/provider-run';
import { ensureWordTiming } from '../../pipeline/word-timing';
import { runPreferredProviders } from '../../services/generate-overrides';
import {
  assetFingerprint,
  candidateProviders,
  findReusableAsset,
  reuseAssetForShot,
  type FingerprintInput,
} from '../../pipeline/asset-reuse';
import { aiClipResolution, clipBudgetOf } from '../../pipeline/clip-budget';
import { fitNarration } from '../../pipeline/narration-fit';
import { availableTreatments } from '../../pipeline/scripting';
import { resolveProjectBrandKit } from '../../pipeline/brand-resolve';
import {
  findLibraryStill,
  isGenerationRefusal,
  keepGeneratedStill,
  stockStillForRefusal,
  stockStillForScene,
} from '../../pipeline/still-image';
import { selectStockVoice } from '../../pipeline/voice-fit';
import { defaultVoiceIdFor, ttsLanguageCode } from '../../pipeline/voice-language';
import { timeClipSpeech } from '../../ugc/clip-speech';
import { ensureActorPortrait } from '../../ugc/portrait';
import { actorClipPrompt } from '../../ugc/prompt';
import { ugcStyleOf, type UgcStyle } from '../../ugc/style';
import { hookClipMarkerOf } from '../../formats/hook-clip';
import { generateHookClip } from './generate-hook-clip';
import { jobIds } from '../enqueue';
import type { GenerateAssetJobData, ProjectJobData } from '../queues';

/** 13.6: transcribe the shot's narration once for word-level karaoke timing (non-fatal). */
async function timeNarration(deps: PipelineDeps, shotId: string, data: GenerateAssetJobData) {
  const current = await deps.db.videoShot.findUnique({
    where: { id: shotId },
    select: { voiceAssetId: true },
  });
  if (!current?.voiceAssetId) return;
  await ensureWordTiming(deps, {
    assetId: current.voiceAssetId,
    organisationId: data.organisationId,
    planTier: data.planTier,
  });
}

// BACKLOG 3.5 — Layers 3 (visual) and 4 (voice) for one shot (spec 4.5 steps 4–5). Outputs are
// copied into the Studio assets bucket (provider URLs expire) and recorded as video_assets.
// When the last shot of the run reaches a terminal state, compose-video is enqueued (fan-in).
// Layer 5 music is produced by compose-video, once per script.
// Phase 15: fingerprint reuse (15.B6), IMAGE_STILL library-first + stock on refusal (15.B5),
// composer-rendered MOTION_GRAPHICS (15.B8), tone-matched stock voices and narration fitted to
// the shot (15.B3).

const TERMINAL_SHOT_STATES = ['READY', 'FAILED', 'SKIPPED'] as const;

type ShotWithScript = VideoShot & {
  script: {
    projectId: string;
    targetAspectRatio: string;
    language: string;
    project: {
      organisationId: string;
      metadata: Prisma.JsonValue;
      brandKitId: string | null;
      businessId: string;
    };
  };
};

interface StoredAsset {
  assetId: string;
  routing: Record<string, unknown>;
}

function routingSnapshot(run: ProviderRunResult): Record<string, unknown> {
  return {
    providerId: run.decision.providerId,
    candidates: run.decision.candidates,
    decidedAt: run.decision.decidedAt,
  };
}

async function recordAsset(
  deps: PipelineDeps,
  shot: ShotWithScript,
  kind: AssetKind,
  run: ProviderRunResult,
  fallback: { extension: string; contentType: string },
  /** 15.B6: what determined the output (fingerprinted with the provider that made it). */
  fingerprint?: FingerprintInput,
  /** 20.19: facts kept on both the asset's metadata and the shot's routing snapshot. */
  extra: Record<string, unknown> = {},
): Promise<StoredAsset> {
  const metadata = { ...((run.output.metadata ?? {}) as Record<string, unknown>), ...extra };
  const organisationId = shot.script.project.organisationId;
  let bucket = typeof metadata.s3Bucket === 'string' ? metadata.s3Bucket : undefined;
  let key = typeof metadata.s3Key === 'string' ? metadata.s3Key : undefined;
  let bytes: number | undefined;
  if (!bucket || !key) {
    if (!run.output.url)
      throw new ValidationError(`${run.decision.providerId} returned no output URL`);
    const copied = await copyUrlToStorage(
      deps.storage,
      {
        url: run.output.url,
        bucket: deps.config.assetsBucket,
        key: providerOutputKey({
          organisationId,
          projectId: shot.script.projectId,
          providerId: run.decision.providerId,
          extension: fallback.extension,
        }),
        fallbackContentType: fallback.contentType,
        providerId: run.decision.providerId,
      },
      // 20.20: Veo outputs need the provider key to download (veo.ts fetchOutput).
      run.fetchOutput ?? deps.fetch,
    );
    bucket = copied.bucket;
    key = copied.key;
    bytes = copied.bytes;
  }
  const job = await deps.db.providerJob.findUnique({
    where: { id: run.providerJobRowId },
    select: { costPence: true },
  });
  const model = typeof metadata.model === 'string' ? `:${metadata.model}` : '';
  const pointer = kind === 'AUDIO_VOICE' ? 'voiceAssetId' : 'assetId';
  const routingKey = kind === 'AUDIO_VOICE' ? 'voice' : 'visual';
  // The asset row and the shot's pointer to it commit together, so a retry after a crash never
  // regenerates (and re-pays for) an asset that was already recorded.
  const asset = await deps.db.$transaction(async (tx) => {
    const created = await tx.videoAsset.create({
      data: {
        organisationId,
        projectId: shot.script.projectId,
        shotId: shot.id,
        kind,
        source: `${run.decision.providerId}${model}`,
        s3Bucket: bucket,
        s3Key: key,
        durationSec: kind === 'IMAGE' ? null : shot.durationSec,
        fileSizeBytes:
          bytes === undefined
            ? typeof metadata.bytes === 'number'
              ? BigInt(metadata.bytes)
              : null
            : BigInt(bytes),
        providerJobId: run.providerJobRowId,
        costPence: job?.costPence ?? 0,
        fingerprint: fingerprint ? assetFingerprint(run.decision.providerId, fingerprint) : null,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
    const current = await tx.videoShot.findUniqueOrThrow({
      where: { id: shot.id },
      select: { providerRouting: true },
    });
    await tx.videoShot.update({
      where: { id: shot.id },
      data: {
        [pointer]: created.id,
        providerRouting: {
          ...((current.providerRouting as Record<string, unknown> | null) ?? {}),
          [routingKey]: { ...routingSnapshot(run), ...extra },
        } as Prisma.InputJsonValue,
      },
    });
    return created;
  });
  return { assetId: asset.id, routing: { ...routingSnapshot(run), ...extra } };
}

/** Provider requested via POST /api/studio/shots/:id/regenerate, if any. */
function preferredProvider(shot: ShotWithScript): string[] {
  const routing = shot.providerRouting as { preferredProviderId?: unknown } | null;
  const shotPick =
    typeof routing?.preferredProviderId === 'string' ? [routing.preferredProviderId] : [];
  // 15.C4: then the run's preferredProviders for this treatment (generate body).
  return [
    ...shotPick,
    ...runPreferredProviders(shot.script.project.metadata, shot.visualTreatment),
  ];
}

/**
 * BACKLOG 13.32 — AI_AVATAR: the avatar provider (HeyGen) lip-syncs to the shot's narration, so
 * the presenter speaks in the brand voice and matches the composer's separate voice track.
 */
async function generateAvatar(
  deps: PipelineDeps,
  shot: ShotWithScript,
  data: GenerateAssetJobData,
  voiceAssetId: string | null,
): Promise<StoredAsset> {
  if (!voiceAssetId) {
    throw new ValidationError('AI_AVATAR shots need voiceover text for the avatar to speak');
  }
  const voice = await deps.db.videoAsset.findFirst({
    where: { id: voiceAssetId, organisationId: data.organisationId, kind: 'AUDIO_VOICE' },
    select: { s3Bucket: true, s3Key: true },
  });
  if (!voice?.s3Bucket || !voice.s3Key) throw new NotFoundError('Narration asset not found');
  let run: ProviderRunResult;
  try {
    run = await runProvider(
      {
        need: { kind: 'shot', visualTreatment: 'AI_AVATAR', durationSec: shot.durationSec },
        planTier: data.planTier,
        preferredProviderId: preferredProvider(shot),
        request: {
          organisationId: data.organisationId,
          projectId: data.projectId,
          shotId: shot.id,
          capability: 'avatar_video',
          audioUrl: await deps.storage.signedUrl(voice.s3Bucket, voice.s3Key),
          durationSec: shot.durationSec,
          aspectRatio: shot.script.targetAspectRatio as AspectRatio,
        },
      },
      deps,
    );
  } catch (err) {
    // 20.19: no presenter available (account problem, hold, kill switch…) → a regular clip.
    const reason = avatarUnavailableReason(err);
    if (!reason) throw err;
    return generatePresenterlessClip(deps, shot, data, reason);
  }
  return recordAsset(deps, shot, 'VIDEO_CLIP', run, { extension: 'mp4', contentType: 'video/mp4' });
}

/** 21.4: the UGC product image (an image_library row of the project's business), if chosen. */
async function ugcProductImage(
  deps: PipelineDeps,
  shot: ShotWithScript,
  ugc: UgcStyle,
): Promise<{
  id: string;
  s3Bucket: string;
  s3Key: string;
  widthPx: number;
  heightPx: number;
} | null> {
  if (!ugc.product.imageId) return null;
  return deps.db.imageLibraryItem.findFirst({
    where: {
      id: ugc.product.imageId,
      organisationId: shot.script.project.organisationId,
      businessId: shot.script.project.businessId,
    },
    select: { id: true, s3Bucket: true, s3Key: true, widthPx: true, heightPx: true },
  });
}

/**
 * BACKLOG 21.4 — a UGC_ACTOR shot: a generated actor speaks the shot's line to camera, with the
 * provider's own audio (Veo first, router.ts ACTOR_CANDIDATES). The same actor description and
 * seed go to every clip of the project, and the business's product image (when chosen) goes as a
 * reference so the product is in view. 21.4a: so does the project's actor portrait
 * (ugc/portrait.ts), the same image for every clip. With no actor provider available (account problem, hold,
 * kill switch, nothing configured) the shot degrades like an avatar shot: the line is narrated by
 * the brand voice over a generated B-roll clip (degradedFrom 'actor_video').
 */
async function generateActor(
  deps: PipelineDeps,
  shot: ShotWithScript,
  data: GenerateAssetJobData,
  ugc: UgcStyle,
): Promise<StoredAsset> {
  if (!shot.voiceoverText) throw new ValidationError('UGC_ACTOR shots need a line to speak');
  // A retry after a degraded attempt already narrated the line: finish the degraded shot.
  if (shot.voiceAssetId)
    return generatePresenterlessClip(deps, shot, data, 'retry', DEGRADED_FROM_ACTOR);
  const product = await ugcProductImage(deps, shot, ugc);
  const productImageUrl = product
    ? await deps.storage.signedUrl(product.s3Bucket, product.s3Key)
    : undefined;
  // 21.4a: the project's one actor portrait (made by the first actor shot that asks, reused by
  // every other clip and every regenerated clip), so the actor stays the same person. Not made
  // when no actor provider is configured at all (the shot degrades to narrated B-roll).
  const portrait =
    deps.registry.getAdaptersByCapability('actor_video').length > 0
      ? await ensureActorPortrait(deps, {
          projectId: data.projectId,
          organisationId: data.organisationId,
          runId: data.runId,
          planTier: data.planTier,
          style: ugc,
          shotId: shot.id,
        })
      : null;
  let run: ProviderRunResult;
  try {
    run = await runProvider(
      {
        need: { kind: 'shot', visualTreatment: 'UGC_ACTOR', durationSec: shot.durationSec },
        planTier: data.planTier,
        preferredProviderId: preferredProvider(shot),
        request: {
          organisationId: data.organisationId,
          projectId: data.projectId,
          shotId: shot.id,
          capability: 'actor_video',
          prompt: actorClipPrompt({
            style: ugc,
            sceneDescription: shot.sceneDescription,
            cameraDirection: shot.cameraDirection,
            productReference: Boolean(productImageUrl),
            actorReference: Boolean(portrait),
          }),
          spokenLine: shot.voiceoverText,
          languageCode: shot.script.language,
          durationSec: shot.durationSec,
          aspectRatio: shot.script.targetAspectRatio as AspectRatio,
          ...(productImageUrl && { productImageUrl }),
          ...(portrait && { actorImageUrl: portrait.url }),
          seed: ugc.seed,
        },
      },
      deps,
    );
  } catch (err) {
    const reason = avatarUnavailableReason(err);
    if (!reason) throw err;
    await generateVoice(deps, shot, data);
    return generatePresenterlessClip(deps, shot, data, reason, DEGRADED_FROM_ACTOR);
  }
  return recordAsset(
    deps,
    shot,
    'VIDEO_CLIP',
    run,
    { extension: 'mp4', contentType: 'video/mp4' },
    undefined,
    {
      speech: 'clip',
      ...(product && { productImageId: product.id }),
      ...(portrait && { actorImageAssetId: portrait.assetId }),
    },
  );
}

/**
 * BACKLOG 20.19 — an AI_AVATAR shot whose presenter is unavailable becomes a generated B-roll clip
 * (text_to_video through the router, so cost tracking, budgets and the cost cap apply as for any
 * AI_CLIP). The narration generated for the avatar stays the shot's voice track and the shot keeps
 * its duration; the composer trims the clip to it. The degradation is recorded on the asset and
 * the shot's routing snapshot (degradedFrom / degradedReason) for the review-screen note.
 */
async function generatePresenterlessClip(
  deps: PipelineDeps,
  shot: ShotWithScript,
  data: GenerateAssetJobData,
  reason: string,
  /** 21.4: 'actor_video' for a UGC actor shot that had no actor provider. */
  degradedFrom: string = DEGRADED_FROM_AVATAR,
): Promise<StoredAsset> {
  const kit = await resolveProjectBrandKit(deps.db, shot.script.project);
  const prompt = degradedClipPrompt({
    sceneDescription: shot.sceneDescription,
    voiceoverText: shot.voiceoverText,
    cameraDirection: shot.cameraDirection,
    toneKeywords: kit?.toneKeywords ?? [],
  });
  const durationSec = degradedClipDurationSec(shot.durationSec);
  deps.logger.warn(
    { projectId: data.projectId, shotId: shot.id, reason, degradedFrom },
    'presenter or actor unavailable; shot degraded to a generated clip',
  );
  const run = await runProvider(
    {
      need: { kind: 'shot', visualTreatment: 'AI_CLIP', durationSec },
      planTier: data.planTier,
      preferredProviderId: runPreferredProviders(shot.script.project.metadata, 'AI_CLIP'),
      request: {
        organisationId: data.organisationId,
        projectId: data.projectId,
        shotId: shot.id,
        capability: 'text_to_video',
        prompt,
        durationSec,
        aspectRatio: shot.script.targetAspectRatio as AspectRatio,
        resolution: aiClipResolution(data.planTier),
      },
    },
    deps,
  );
  return recordAsset(
    deps,
    shot,
    'VIDEO_CLIP',
    run,
    { extension: 'mp4', contentType: 'video/mp4' },
    undefined,
    { degradedFrom, degradedReason: reason },
  );
}

/**
 * 15.B6: reuse an identical earlier generation instead of paying again. A shot being regenerated
 * (it already has a routing snapshot for this layer) always generates afresh.
 */
async function reuse(
  deps: PipelineDeps,
  shot: ShotWithScript,
  data: GenerateAssetJobData,
  input: {
    kind: AssetKind;
    need: Parameters<typeof candidateProviders>[0];
    fingerprint: FingerprintInput;
    layer: 'visual' | 'voice';
  },
): Promise<StoredAsset | null> {
  const routing = (shot.providerRouting as Record<string, unknown> | null) ?? {};
  if (input.layer === 'visual' && routing.visual) return null;
  // A shot regenerated on a named provider reuses only that provider's output.
  const preferred =
    typeof routing.preferredProviderId === 'string' ? routing.preferredProviderId : undefined;
  const providers = candidateProviders(input.need, data.planTier);
  const source = await findReusableAsset(deps, {
    organisationId: data.organisationId,
    kind: input.kind,
    providers: preferred ? providers.filter((p) => p === preferred) : providers,
    fingerprint: input.fingerprint,
  });
  if (!source) return null;
  const asset = await reuseAssetForShot(deps, {
    source,
    shotId: shot.id,
    projectId: data.projectId,
    capability: input.fingerprint.capability,
    pointer: input.layer === 'voice' ? 'voiceAssetId' : 'assetId',
    routingKey: input.layer,
  });
  deps.logger.info(
    { shotId: shot.id, reusedFromAssetId: source.id, savedPence: source.costPence },
    'reused an identical earlier generation',
  );
  return { assetId: asset.id, routing: { reused: true, reusedFromAssetId: source.id } };
}

/** 15.B5: record a library image as the shot's still (no provider call). */
async function recordLibraryStill(
  deps: PipelineDeps,
  shot: ShotWithScript,
  item: { id: string; s3Bucket: string; s3Key: string; widthPx: number; heightPx: number },
  how: 'library' | 'stock' | 'stock_after_refusal',
): Promise<StoredAsset> {
  const asset = await deps.db.$transaction(async (tx) => {
    const created = await tx.videoAsset.create({
      data: {
        organisationId: shot.script.project.organisationId,
        projectId: shot.script.projectId,
        shotId: shot.id,
        kind: 'IMAGE',
        source: `image-library:${item.id}`,
        s3Bucket: item.s3Bucket,
        s3Key: item.s3Key,
        widthPx: item.widthPx,
        heightPx: item.heightPx,
        metadata: { imageLibraryId: item.id, chosenBy: how },
      },
    });
    const current = await tx.videoShot.findUniqueOrThrow({
      where: { id: shot.id },
      select: { providerRouting: true },
    });
    await tx.videoShot.update({
      where: { id: shot.id },
      data: {
        assetId: created.id,
        providerRouting: {
          ...((current.providerRouting as Record<string, unknown> | null) ?? {}),
          visual: {
            providerId: 'image-library',
            imageLibraryId: item.id,
            chosenBy: how,
            candidates: [],
          },
        } as Prisma.InputJsonValue,
      },
    });
    return created;
  });
  return { assetId: asset.id, routing: { imageLibraryId: item.id, chosenBy: how } };
}

async function generateStill(
  deps: PipelineDeps,
  shot: ShotWithScript,
  data: GenerateAssetJobData,
  prompt: string,
): Promise<StoredAsset> {
  const aspectRatio = shot.script.targetAspectRatio as AspectRatio;
  const scope = {
    organisationId: data.organisationId,
    businessId: shot.script.project.businessId,
    planTier: data.planTier,
  };
  const fingerprint: FingerprintInput = { capability: 'text_to_image', prompt, aspectRatio };
  const need = { kind: 'shot' as const, visualTreatment: 'IMAGE_STILL' as const, durationSec: 5 };
  const reused = await reuse(deps, shot, data, {
    kind: 'IMAGE',
    need,
    fingerprint,
    layer: 'visual',
  });
  if (reused) return reused;
  // A6.5: the business's image library before any generator (not on an explicit regenerate).
  const regenerating = Boolean((shot.providerRouting as Record<string, unknown> | null)?.visual);
  const hit = regenerating ? null : await findLibraryStill(deps, scope, shot.sceneDescription);
  if (hit) return recordLibraryStill(deps, shot, hit, 'library');
  // 20.25: a free stock image before a paid generation (not on an explicit regenerate).
  const stocked = regenerating
    ? null
    : await stockStillForScene(
        deps,
        { ...scope, projectId: data.projectId },
        { query: shot.sceneDescription, aspectRatio },
        'shot',
      );
  if (stocked) return recordLibraryStill(deps, shot, stocked, 'stock');
  let run: ProviderRunResult;
  try {
    run = await runProvider(
      {
        need: { kind: 'shot', visualTreatment: 'IMAGE_STILL', durationSec: shot.durationSec },
        planTier: data.planTier,
        preferredProviderId: preferredProvider(shot),
        request: {
          organisationId: data.organisationId,
          projectId: data.projectId,
          shotId: shot.id,
          capability: 'text_to_image',
          prompt,
          aspectRatio,
        },
      },
      deps,
    );
  } catch (err) {
    // A11.4 / 15.W6: a refused generation falls back to the closest stock match (already tried
    // above unless the shot is being regenerated).
    if (!isGenerationRefusal(err) || !regenerating) throw err;
    const stock = await stockStillForRefusal(
      deps,
      { ...scope, projectId: data.projectId },
      { query: shot.sceneDescription, aspectRatio },
    );
    if (!stock) throw err;
    return recordLibraryStill(deps, shot, stock, 'stock_after_refusal');
  }
  const stored = await recordAsset(
    deps,
    shot,
    'IMAGE',
    run,
    { extension: 'png', contentType: 'image/png' },
    fingerprint,
  );
  // A6.3: every generated image is kept in the library so it can be reused.
  const asset = await deps.db.videoAsset.findUnique({
    where: { id: stored.assetId },
    select: { s3Bucket: true, s3Key: true },
  });
  if (asset)
    await keepGeneratedStill(deps, scope, {
      bucket: asset.s3Bucket,
      key: asset.s3Key,
      prompt,
      providerId: run.decision.providerId,
    });
  return stored;
}

/**
 * BACKLOG 20.25: a shot the AI clip budget turned into a still (pipeline/clip-budget.ts). Never a
 * paid generation: the business's own image, then a stock image, else the composer draws a
 * motion-graphics card (a text card when Shotstack is not the composer) from the shot's text.
 */
async function budgetStill(
  deps: PipelineDeps,
  shot: ShotWithScript,
  data: GenerateAssetJobData,
): Promise<StoredAsset | null> {
  const scope = {
    organisationId: data.organisationId,
    businessId: shot.script.project.businessId,
    planTier: data.planTier,
  };
  const regenerating = Boolean((shot.providerRouting as Record<string, unknown> | null)?.visual);
  const hit = regenerating ? null : await findLibraryStill(deps, scope, shot.sceneDescription);
  if (hit) return recordLibraryStill(deps, shot, hit, 'library');
  const stock = await stockStillForScene(
    deps,
    { ...scope, projectId: data.projectId },
    { query: shot.sceneDescription, aspectRatio: shot.script.targetAspectRatio },
    'shot',
  );
  if (stock) return recordLibraryStill(deps, shot, stock, 'stock');
  const card = availableTreatments(deps.registry).includes('MOTION_GRAPHICS')
    ? ('MOTION_GRAPHICS' as const)
    : ('TEXT_CARD' as const);
  const current = await deps.db.videoShot.findUniqueOrThrow({
    where: { id: shot.id },
    select: { providerRouting: true },
  });
  const visual = { providerId: 'composer', chosenBy: 'clip_budget_card', candidates: [] };
  await deps.db.videoShot.update({
    where: { id: shot.id },
    data: {
      visualTreatment: card,
      providerRouting: {
        ...((current.providerRouting as Record<string, unknown> | null) ?? {}),
        visual,
      } as Prisma.InputJsonValue,
    },
  });
  deps.logger.info(
    { projectId: data.projectId, shotId: shot.id, treatment: card },
    'no library or stock image for a clip-budget shot; the composer draws a card',
  );
  return null;
}

async function generateVisual(
  deps: PipelineDeps,
  shot: ShotWithScript,
  data: GenerateAssetJobData,
  voiceAssetId: string | null,
): Promise<StoredAsset | null> {
  const base = { organisationId: data.organisationId, projectId: data.projectId, shotId: shot.id };
  const aspectRatio = shot.script.targetAspectRatio as AspectRatio;
  const prompt = [shot.sceneDescription, shot.cameraDirection].filter(Boolean).join(' Camera: ');
  switch (shot.visualTreatment) {
    case 'TEXT_CARD':
    case 'MOTION_GRAPHICS':
      return null; // rendered by the composer from the shot's text (15.B8: motion cards)
    case 'AI_CLIP': {
      // 22.1: the hook of a hook + demo video is a silent reaction clip (generate-hook-clip.ts).
      const hook = hookClipMarkerOf(shot.providerRouting);
      if (hook)
        return generateHookClip(deps, shot, data, hook, (run, extra) =>
          recordAsset(
            deps,
            shot,
            'VIDEO_CLIP',
            run,
            { extension: 'mp4', contentType: 'video/mp4' },
            undefined,
            extra,
          ),
        );
      // 20.25 / 21.3: clips by plan tier (720p on every tier since 21.3); a clip is never reused for
      // a shot at another requested resolution (720p keeps the pre-20.25 fingerprint).
      const resolution = aiClipResolution(data.planTier);
      const fingerprint: FingerprintInput = {
        capability: 'text_to_video',
        prompt,
        durationSec: shot.durationSec,
        aspectRatio,
        ...(resolution !== '720p' && { seed: `resolution:${resolution}` }),
      };
      const reused = await reuse(deps, shot, data, {
        kind: 'VIDEO_CLIP',
        need: { kind: 'shot', visualTreatment: 'AI_CLIP', durationSec: shot.durationSec },
        fingerprint,
        layer: 'visual',
      });
      if (reused) return reused;
      const run = await runProvider(
        {
          need: { kind: 'shot', visualTreatment: 'AI_CLIP', durationSec: shot.durationSec },
          planTier: data.planTier,
          preferredProviderId: preferredProvider(shot),
          request: {
            ...base,
            capability: 'text_to_video',
            prompt,
            durationSec: shot.durationSec,
            aspectRatio,
            resolution,
          },
        },
        deps,
      );
      return recordAsset(
        deps,
        shot,
        'VIDEO_CLIP',
        run,
        { extension: 'mp4', contentType: 'video/mp4' },
        fingerprint,
      );
    }
    case 'IMAGE_STILL': {
      // 21.4: a UGC video's stills are the owner's product photo when one was chosen.
      const ugc = ugcStyleOf(shot.script.project.metadata);
      const product = ugc ? await ugcProductImage(deps, shot, ugc) : null;
      if (product) return recordLibraryStill(deps, shot, product, 'library');
      return clipBudgetOf(shot.providerRouting)
        ? budgetStill(deps, shot, data)
        : generateStill(deps, shot, data, prompt);
    }
    case 'UGC_ACTOR': {
      const ugc = ugcStyleOf(shot.script.project.metadata);
      if (!ugc) throw new ValidationError('UGC_ACTOR shot in a project without the UGC style');
      return generateActor(deps, shot, data, ugc);
    }
    case 'STOCK_FOOTAGE': {
      // Phase 15 (Track C): Storyblocks video, then Pexels video. The scene description is the
      // search text; the adapter returns the licence facts, kept in the asset's metadata.
      const run = await runProvider(
        {
          need: { kind: 'shot', visualTreatment: 'STOCK_FOOTAGE', durationSec: shot.durationSec },
          planTier: data.planTier,
          preferredProviderId: preferredProvider(shot),
          request: {
            ...base,
            capability: 'stock_footage',
            query: shot.sceneDescription,
            durationSec: shot.durationSec,
            aspectRatio,
          },
        },
        deps,
      );
      return recordAsset(deps, shot, 'VIDEO_CLIP', run, {
        extension: 'mp4',
        contentType: 'video/mp4',
      });
    }
    case 'AI_AVATAR':
      return generateAvatar(deps, shot, data, voiceAssetId);
    default:
      throw new ValidationError(`No asset generator for ${shot.visualTreatment} shots yet`);
  }
}

async function resolveVoiceId(deps: PipelineDeps, shot: ShotWithScript): Promise<string> {
  const project = shot.script.project;
  const kit = await resolveProjectBrandKit(deps.db, project);
  if (kit?.voiceProfileId) {
    const profile = await deps.db.voiceProfile.findFirst({
      // 13.13: a deleted or unverified clone is never used (spec 10.2: fall back to default).
      where: {
        id: kit.voiceProfileId,
        organisationId: project.organisationId,
        state: 'READY',
        deletedAt: null,
      },
    });
    if (profile?.provider === 'elevenlabs') return profile.providerVoiceId;
  }
  // 15.B3 spec 5.5: one of the pre-selected stock voices matched to the brand's declared tone.
  const stock = selectStockVoice(
    kit?.toneKeywords ?? [],
    shot.script.language,
    deps.config.stockVoices ?? new Map(),
  );
  if (stock) return stock;
  // 15.C5: the script language's default voice (ELEVENLABS_DEFAULT_VOICE_ID_<LANG>), then global.
  const fallback = defaultVoiceIdFor(shot.script.language, deps.config.defaultVoiceId);
  if (fallback) return fallback;
  throw new ConfigurationError('No brand voice and ELEVENLABS_DEFAULT_VOICE_ID is not set');
}

async function generateVoice(
  deps: PipelineDeps,
  shot: ShotWithScript,
  data: GenerateAssetJobData,
  options: { speed?: number } = {},
): Promise<StoredAsset | null> {
  if (!shot.voiceoverText) return null;
  const voiceId = await resolveVoiceId(deps, shot);
  const fingerprint: FingerprintInput = {
    capability: 'tts',
    prompt: shot.voiceoverText,
    seed: `${voiceId}|${options.speed ?? 1}`,
  };
  const reused = await reuse(deps, shot, data, {
    kind: 'AUDIO_VOICE',
    need: { kind: 'capability', capability: 'tts' },
    fingerprint,
    layer: 'voice',
  });
  if (reused) return reused;
  const run = await runProvider(
    {
      need: { kind: 'capability', capability: 'tts' },
      planTier: data.planTier,
      request: {
        capability: 'tts',
        organisationId: data.organisationId,
        projectId: data.projectId,
        shotId: shot.id,
        text: shot.voiceoverText,
        voiceId,
        languageCode: ttsLanguageCode(shot.script.language),
        ...(options.speed !== undefined && { speed: options.speed }),
      },
    },
    deps,
  );
  return recordAsset(
    deps,
    shot,
    'AUDIO_VOICE',
    run,
    { extension: 'mp3', contentType: 'audio/mpeg' },
    fingerprint,
  );
}

/** Fan-in: enqueue compose once every shot of the run is terminal (idempotent by jobId). */
export async function enqueueComposeIfReady(
  deps: PipelineDeps,
  data: ProjectJobData,
): Promise<boolean> {
  const outstanding = await deps.db.videoShot.count({
    where: { script: { projectId: data.projectId }, state: { notIn: [...TERMINAL_SHOT_STATES] } },
  });
  if (outstanding > 0) return false;
  const job: ProjectJobData = {
    projectId: data.projectId,
    organisationId: data.organisationId,
    runId: data.runId,
    planTier: data.planTier,
    batch: data.batch,
  };
  await deps.queue.add('compose-video', job, { jobId: jobIds.composeVideo(job) });
  return true;
}

export async function generateAsset(data: GenerateAssetJobData, deps: PipelineDeps): Promise<void> {
  const shot = (await deps.db.videoShot.findUnique({
    where: { id: data.shotId },
    include: {
      script: {
        select: {
          projectId: true,
          targetAspectRatio: true,
          language: true,
          project: {
            select: { organisationId: true, metadata: true, brandKitId: true, businessId: true },
          },
        },
      },
    },
  })) as ShotWithScript | null;
  if (
    !shot ||
    shot.script.project.organisationId !== data.organisationId ||
    shot.script.projectId !== data.projectId
  ) {
    throw new NotFoundError('Shot not found');
  }
  if (currentRunId(shot.script.project) !== data.runId) return;
  if ((TERMINAL_SHOT_STATES as readonly string[]).includes(shot.state)) {
    await enqueueComposeIfReady(deps, data);
    return;
  }

  await transitionProject(deps.db, {
    projectId: data.projectId,
    runId: data.runId,
    from: ['ASSETS_QUEUED'],
    to: 'ASSETS_GENERATING',
  });
  await deps.db.videoShot.update({
    where: { id: shot.id },
    data: { state: 'GENERATING', errorReason: null },
  });

  // A retry keeps an already-generated visual rather than paying for it twice.
  // Each generator records its asset and the shot pointer atomically (see recordAsset).
  // Avatar shots need their narration first: the avatar lip-syncs to it.
  const voiceFirst = shot.visualTreatment === 'AI_AVATAR';
  let voiceAssetId = shot.voiceAssetId;
  if (voiceFirst && !voiceAssetId) {
    voiceAssetId = (await generateVoice(deps, shot, data))?.assetId ?? null;
  }
  if (!shot.assetId) await generateVisual(deps, shot, data, voiceAssetId);
  // 21.4: an actor clip speaks its own line (a degraded one was narrated in generateActor).
  const actor = shot.visualTreatment === 'UGC_ACTOR';
  if (!voiceFirst && !actor && !shot.voiceAssetId) await generateVoice(deps, shot, data);
  await timeNarration(deps, shot.id, data);
  if (actor)
    await timeClipSpeech(deps, {
      shotId: shot.id,
      organisationId: data.organisationId,
      planTier: data.planTier,
    });
  // 15.B3: extend the shot, speak faster (once) or trim at a word boundary when it runs over.
  await fitNarration(deps, {
    shotId: shot.id,
    organisationId: data.organisationId,
    planTier: data.planTier,
    regenerateFaster: async (speed) => {
      const current = (await deps.db.videoShot.findUnique({
        where: { id: shot.id },
        include: {
          script: {
            select: {
              projectId: true,
              targetAspectRatio: true,
              language: true,
              project: {
                select: {
                  organisationId: true,
                  metadata: true,
                  brandKitId: true,
                  businessId: true,
                },
              },
            },
          },
        },
      })) as ShotWithScript | null;
      return current
        ? ((await generateVoice(deps, current, data, { speed }))?.assetId ?? null)
        : null;
    },
  });

  await deps.db.videoShot.update({ where: { id: shot.id }, data: { state: 'READY' } });
  await enqueueComposeIfReady(deps, data);
}

export async function onGenerateAssetFailed(
  data: GenerateAssetJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  await deps.db.videoShot.updateMany({
    where: { id: data.shotId, state: { notIn: ['READY', 'SKIPPED'] } },
    data: { state: 'FAILED', errorReason: reason.slice(0, 2_000) },
  });
  await enqueueComposeIfReady(deps, data);
}
