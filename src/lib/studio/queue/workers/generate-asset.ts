import type { AssetKind, Prisma, VideoShot } from '@prisma/client';
import { ConfigurationError, NotFoundError, ValidationError } from '../../../errors';
import type { AspectRatio } from '../../providers/interface';
import { providerOutputKey } from '../../storage';
import type { PipelineDeps } from '../../pipeline/deps';
import { copyUrlToStorage } from '../../pipeline/persist';
import { currentRunId, transitionProject } from '../../pipeline/project-state';
import { runProvider, type ProviderRunResult } from '../../pipeline/provider-run';
import { jobIds } from '../enqueue';
import type { GenerateAssetJobData, ProjectJobData } from '../queues';

// BACKLOG 3.5 — Layers 3 (visual) and 4 (voice) for one shot (spec 4.5 steps 4–5). Outputs are
// copied into the Studio assets bucket (provider URLs expire) and recorded as video_assets.
// When the last shot of the run reaches a terminal state, compose-video is enqueued (fan-in).
// Layer 5 music is produced by compose-video, once per script.

const TERMINAL_SHOT_STATES = ['READY', 'FAILED', 'SKIPPED'] as const;

type ShotWithScript = VideoShot & {
  script: {
    projectId: string;
    targetAspectRatio: string;
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
): Promise<StoredAsset> {
  const metadata = (run.output.metadata ?? {}) as Record<string, unknown>;
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
      deps.fetch,
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
          [routingKey]: routingSnapshot(run),
        } as Prisma.InputJsonValue,
      },
    });
    return created;
  });
  return { assetId: asset.id, routing: routingSnapshot(run) };
}

async function generateVisual(
  deps: PipelineDeps,
  shot: ShotWithScript,
  data: GenerateAssetJobData,
): Promise<StoredAsset | null> {
  const base = { organisationId: data.organisationId, projectId: data.projectId, shotId: shot.id };
  const aspectRatio = shot.script.targetAspectRatio as AspectRatio;
  const prompt = [shot.sceneDescription, shot.cameraDirection].filter(Boolean).join(' Camera: ');
  switch (shot.visualTreatment) {
    case 'TEXT_CARD':
      return null; // rendered by the composer from the shot's text
    case 'AI_CLIP': {
      const run = await runProvider(
        {
          need: { kind: 'shot', visualTreatment: 'AI_CLIP', durationSec: shot.durationSec },
          planTier: data.planTier,
          request: {
            ...base,
            capability: 'text_to_video',
            prompt,
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
    case 'IMAGE_STILL': {
      const run = await runProvider(
        {
          need: { kind: 'shot', visualTreatment: 'IMAGE_STILL', durationSec: shot.durationSec },
          planTier: data.planTier,
          request: { ...base, capability: 'text_to_image', prompt, aspectRatio },
        },
        deps,
      );
      return recordAsset(deps, shot, 'IMAGE', run, { extension: 'png', contentType: 'image/png' });
    }
    default:
      throw new ValidationError(`No asset generator for ${shot.visualTreatment} shots yet`);
  }
}

async function resolveVoiceId(deps: PipelineDeps, shot: ShotWithScript): Promise<string> {
  const project = shot.script.project;
  const kit = project.brandKitId
    ? await deps.db.brandKit.findFirst({
        where: { id: project.brandKitId, organisationId: project.organisationId },
      })
    : await deps.db.brandKit.findFirst({
        where: {
          organisationId: project.organisationId,
          businessId: project.businessId,
          isDefault: true,
        },
      });
  if (kit?.voiceProfileId) {
    const profile = await deps.db.voiceProfile.findFirst({
      where: { id: kit.voiceProfileId, organisationId: project.organisationId },
    });
    if (profile?.provider === 'elevenlabs') return profile.providerVoiceId;
  }
  if (deps.config.defaultVoiceId) return deps.config.defaultVoiceId;
  throw new ConfigurationError('No brand voice and ELEVENLABS_DEFAULT_VOICE_ID is not set');
}

async function generateVoice(
  deps: PipelineDeps,
  shot: ShotWithScript,
  data: GenerateAssetJobData,
): Promise<StoredAsset | null> {
  if (!shot.voiceoverText) return null;
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
        voiceId: await resolveVoiceId(deps, shot),
      },
    },
    deps,
  );
  return recordAsset(deps, shot, 'AUDIO_VOICE', run, {
    extension: 'mp3',
    contentType: 'audio/mpeg',
  });
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
  if (!shot.assetId) await generateVisual(deps, shot, data);
  if (!shot.voiceAssetId) await generateVoice(deps, shot, data);

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
