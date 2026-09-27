import { ConflictError, NotFoundError, ProviderError } from '../../../errors';

/** Thrown inside the render transaction to roll it back when the run was superseded. */
class StaleRunError extends ConflictError {
  constructor() {
    super('Run superseded');
  }
}
import type { AspectRatio } from '../../providers/interface';
import { providerOutputKey } from '../../storage';
import type { PipelineDeps } from '../../pipeline/deps';
import { buildShotstackEdit, totalDuration, type EdlShot } from '../../pipeline/edl';
import { copyUrlToStorage } from '../../pipeline/persist';
import {
  currentRunId,
  failProject,
  mergeProjectMetadata,
  recordRunRender,
  projectMetadata,
  transitionProject,
} from '../../pipeline/project-state';
import { runProvider } from '../../pipeline/provider-run';
import { buildSlideshowEdit, slideshowDuration } from '../../slideshow/edl';
import { resolveSlides } from '../../slideshow/resolve';
import { jobIds } from '../enqueue';
import type { ProjectJobData } from '../queues';

// BACKLOG 3.6 — Layers 5–7 (spec 4.5 step 6): optional music, Shotstack edit list per script,
// render, copy the MP4 into the renders bucket, probe it, record video_renders, then hand off to
// the quality gate. Renders completed by an earlier attempt are reused (metadata.renders).

export async function composeVideo(data: ProjectJobData, deps: PipelineDeps): Promise<void> {
  const log = deps.logger.child({
    projectId: data.projectId,
    organisationId: data.organisationId,
    runId: data.runId,
  });
  const project = await deps.db.videoProject.findUnique({
    where: { id: data.projectId },
    include: {
      scripts: {
        include: { shots: { orderBy: { sortOrder: 'asc' } } },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!project || project.organisationId !== data.organisationId)
    throw new NotFoundError('Project not found');
  if (currentRunId(project) !== data.runId) return log.info('stale compose-video job ignored');

  const failed = project.scripts.flatMap((s) => s.shots).filter((shot) => shot.state === 'FAILED');
  if (failed.length > 0) {
    await failProject(deps.db, {
      projectId: project.id,
      runId: data.runId,
      reason: `asset_generation_failed: ${failed.map((s) => `shot ${s.sortOrder + 1}: ${s.errorReason ?? 'unknown'}`).join('; ')}`,
    });
    return log.warn({ failedShots: failed.length }, 'shots failed; project failed');
  }

  if (project.state !== 'RENDERING') {
    const moved = await transitionProject(deps.db, {
      projectId: project.id,
      runId: data.runId,
      from: ['ASSETS_QUEUED', 'ASSETS_GENERATING'],
      to: 'RENDERING',
    });
    if (!moved) return log.info({ state: project.state }, 'project not ready to render; skipped');
  }

  // Layer 5 — music. No music adapter (Suno/MusicGen/Storyblocks) exists yet: record that
  // honestly instead of pretending a track was added.
  const musicProviders = deps.registry.getAdaptersByCapability('music');
  if (musicProviders.length === 0) {
    await mergeProjectMetadata(deps.db, {
      projectId: project.id,
      runId: data.runId,
      patch: { music: { skipped: 'no music provider configured' } },
    });
  }

  const assetIds = project.scripts
    .flatMap((s) => s.shots.flatMap((shot) => [shot.assetId, shot.voiceAssetId]))
    .filter((id): id is string => Boolean(id));
  const assets = new Map(
    (
      await deps.db.videoAsset.findMany({
        where: { id: { in: assetIds }, organisationId: project.organisationId },
      })
    ).map((a) => [a.id, a]),
  );
  const signed = async (id: string | null) => {
    const asset = id ? assets.get(id) : undefined;
    return asset
      ? { url: await deps.storage.signedUrl(asset.s3Bucket, asset.s3Key), kind: asset.kind }
      : undefined;
  };

  const renders: Record<string, string> = {
    ...((projectMetadata(project.metadata).renders as Record<string, string>) ?? {}),
  };
  const kit = project.brandKitId
    ? await deps.db.brandKit.findFirst({
        where: { id: project.brandKitId, organisationId: project.organisationId },
      })
    : null;
  const palette = Array.isArray(kit?.colourPalette)
    ? (kit.colourPalette as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];

  // Slideshows (A5) compose from their slides; scripted videos from their shots.
  const slides =
    project.sourceType === 'SLIDESHOW' ? await resolveSlides(deps, project) : undefined;
  const brand = {
    backgroundColour: palette[0],
    textColour: palette[1],
    fontFamily: kit?.fontPrimary ?? undefined,
  };

  const shotEdit = async (
    scriptShots: (typeof project.scripts)[number]['shots'],
    aspectRatio: AspectRatio,
  ) => {
    const shots: EdlShot[] = await Promise.all(
      scriptShots.map(async (shot) => {
        const visual = await signed(shot.assetId);
        const voice = await signed(shot.voiceAssetId);
        return {
          durationSec: shot.durationSec,
          visualTreatment: shot.visualTreatment,
          visualSrc: visual?.url,
          visualKind: visual?.kind === 'IMAGE' ? ('image' as const) : ('video' as const),
          voiceSrc: voice?.url,
          onScreenText: shot.onScreenText,
          transitionOut: shot.transitionOut,
          cardText: shot.onScreenText ?? shot.voiceoverText,
        };
      }),
    );
    return {
      edit: buildShotstackEdit({ aspectRatio, shots, brand }),
      outputDurationSec: totalDuration(shots),
    };
  };

  const outcome = await Promise.all(
    project.scripts
      .filter((script) => !renders[script.id])
      .map(async (script) => {
        const aspectRatio = script.targetAspectRatio as AspectRatio;
        const { edit, outputDurationSec } = slides
          ? {
              edit: buildSlideshowEdit({ aspectRatio, slides, brand }),
              outputDurationSec: slideshowDuration(slides),
            }
          : await shotEdit(script.shots, aspectRatio);
        const run = await runProvider(
          {
            need: { kind: 'capability', capability: 'composition' },
            planTier: data.planTier,
            request: {
              capability: 'composition',
              organisationId: data.organisationId,
              projectId: data.projectId,
              edit,
              outputDurationSec,
            },
          },
          deps,
        );
        if (!run.output.url) {
          throw new ProviderError(
            run.decision.providerId,
            'unknown',
            'Composer returned no render URL',
            true,
          );
        }
        const stored = await copyUrlToStorage(
          deps.storage,
          {
            url: run.output.url,
            bucket: deps.config.rendersBucket,
            key: providerOutputKey({
              organisationId: data.organisationId,
              projectId: data.projectId,
              providerId: run.decision.providerId,
              extension: 'mp4',
            }),
            fallbackContentType: 'video/mp4',
            providerId: run.decision.providerId,
          },
          deps.fetch,
        );
        const probe = await deps.media.probe(stored.url);
        const job = await deps.db.providerJob.findUnique({
          where: { id: run.providerJobRowId },
          select: { costPence: true },
        });
        const metadata = (run.output.metadata ?? {}) as { renderId?: string };
        // The render row and its pointer in metadata.renders commit together: a retry after a
        // crash either sees the pointer (skips this script) or finds neither.
        const render = await deps.db.$transaction(async (tx) => {
          const created = await tx.videoRender.create({
            data: {
              projectId: project.id,
              scriptId: script.id,
              targetPlatform: script.targetPlatform,
              aspectRatio,
              resolution: `${probe.width}x${probe.height}`,
              durationSec: probe.durationSec,
              fps: Math.round(probe.fps),
              bitrateKbps: probe.bitRateKbps,
              s3Bucket: stored.bucket,
              s3Key: stored.key,
              composerJobId: metadata.renderId ?? null,
              qualityCheckState: 'PENDING',
              costPence: job?.costPence ?? 0,
            },
          });
          const recorded = await recordRunRender(tx, {
            projectId: project.id,
            runId: data.runId,
            scriptId: script.id,
            renderId: created.id,
          });
          if (!recorded) throw new StaleRunError();
          return created;
        });
        renders[script.id] = render.id;
      }),
  ).catch((err: unknown) => {
    if (err instanceof StaleRunError) return 'stale';
    throw err;
  });
  if (outcome === 'stale') return log.info('run superseded during composition; renders discarded');
  await transitionProject(deps.db, {
    projectId: project.id,
    runId: data.runId,
    from: ['RENDERING'],
    to: 'QUALITY_CHECKING',
  });
  await deps.queue.add('run-quality-gate', data, { jobId: jobIds.runQualityGate(data) });
  log.info({ renders: Object.keys(renders).length }, 'renders complete; quality gate enqueued');
}

export async function onComposeVideoFailed(
  data: ProjectJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  await failProject(deps.db, {
    projectId: data.projectId,
    runId: data.runId,
    reason: `composition_failed: ${reason}`,
  });
}
