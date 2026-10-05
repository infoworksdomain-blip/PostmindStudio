import type { Prisma } from '@prisma/client';
import { NotFoundError } from '../../../errors';
import type { PipelineDeps } from '../../pipeline/deps';
import {
  currentRunId,
  failProject,
  recordRunRender,
  transitionProject,
} from '../../pipeline/project-state';
import { readCarousel } from '../../carousel/document';
import { blockingIssues, produceCarousel, storeCarousel } from '../../carousel/produce';
import { CAROUSEL_RENDER_PLATFORM } from '../../carousel/publishing';
import { SLIDE_HEIGHT, SLIDE_WIDTH } from '../../carousel/constants';
import { autoApproveIfTrusted } from '../../automation/auto-approve';
import { notifyGenerationComplete } from '../../notifications/events';
import type { ProjectJobData } from '../queues';

// 21.6 — render a carousel (ASSETS_QUEUED → RENDERING → QUALITY_CHECKING → READY_FOR_REVIEW, or
// QUALITY_FAILED). Slides are drawn in-process with sharp (carousel/render.ts: deterministic, no
// provider, no cost), stored as PNG + JPEG in the renders bucket, and recorded as one
// video_renders row (targetPlatform "carousel") whose composition lists the slides. The quality
// checks are the carousel's own (text inside the safe area, no overflow, pictures not stretched,
// WCAG AA contrast); a passed run is auto-approved for trusted creators and notified like a video.

export async function renderCarousel(data: ProjectJobData, deps: PipelineDeps): Promise<void> {
  const log = deps.logger.child({
    projectId: data.projectId,
    organisationId: data.organisationId,
    runId: data.runId,
  });
  const project = await deps.db.videoProject.findUnique({ where: { id: data.projectId } });
  if (!project || project.organisationId !== data.organisationId)
    throw new NotFoundError('Project not found');
  if (currentRunId(project) !== data.runId) return log.info('stale render-carousel job ignored');
  const stored = readCarousel(project.metadata);
  if (!stored || stored.posts.length === 0) {
    await failProject(deps.db, {
      projectId: project.id,
      runId: data.runId,
      reason: 'carousel_incomplete: no posts',
    });
    return log.warn('carousel has no posts to render');
  }
  if (project.state === 'ASSETS_QUEUED') {
    const moved = await transitionProject(deps.db, {
      projectId: project.id,
      runId: data.runId,
      from: ['ASSETS_QUEUED'],
      to: 'RENDERING',
    });
    if (!moved) return log.info('carousel render superseded');
  } else if (project.state !== 'RENDERING') {
    return log.info({ state: project.state }, 'carousel not awaiting a render; skipped');
  }

  const scope = { organisationId: project.organisationId, businessId: project.businessId };
  const produced = await produceCarousel(deps, scope, stored);
  const composition = await storeCarousel(
    { storage: deps.storage, bucket: deps.config.rendersBucket },
    { organisationId: project.organisationId, projectId: project.id },
    stored,
    produced,
  );
  const failing = blockingIssues(produced.issues);
  const first = composition.slides[0];
  if (!first) throw new NotFoundError('Carousel rendered no slides');
  const recorded = await deps.db.$transaction(async (tx) => {
    await tx.videoScript.deleteMany({ where: { projectId: project.id } });
    const script = await tx.videoScript.create({
      data: {
        projectId: project.id,
        targetPlatform: CAROUSEL_RENDER_PLATFORM,
        targetAspectRatio: '4:5',
        targetDurationSec: 0,
        fullText: stored.posts
          .map((p) => p.text)
          .join('\n\n')
          .slice(0, 20_000),
        scriptModel: 'carousel',
        language: stored.language,
      },
    });
    const render = await tx.videoRender.create({
      data: {
        projectId: project.id,
        scriptId: script.id,
        targetPlatform: CAROUSEL_RENDER_PLATFORM,
        aspectRatio: '4:5',
        resolution: `${SLIDE_WIDTH}x${SLIDE_HEIGHT}`,
        durationSec: 0,
        fps: 0,
        bitrateKbps: 0,
        s3Bucket: composition.bucket,
        s3Key: first.pngKey,
        costPence: 0,
        qualityCheckState: failing.length === 0 ? 'PASSED' : 'FAILED',
        qualityIssues: produced.issues as unknown as Prisma.InputJsonValue,
        composition: composition as unknown as Prisma.InputJsonValue,
      },
    });
    const ok = await recordRunRender(tx, {
      projectId: project.id,
      runId: data.runId,
      scriptId: script.id,
      renderId: render.id,
    });
    return ok ? render : null;
  });
  if (!recorded) return log.info('carousel run superseded while rendering');

  await transitionProject(deps.db, {
    projectId: project.id,
    runId: data.runId,
    from: ['RENDERING'],
    to: 'QUALITY_CHECKING',
  });
  const passed = failing.length === 0;
  const moved = await transitionProject(deps.db, {
    projectId: project.id,
    runId: data.runId,
    from: ['QUALITY_CHECKING'],
    to: passed ? 'READY_FOR_REVIEW' : 'QUALITY_FAILED',
    data: passed
      ? { completedAt: new Date(deps.now()), errorReason: null }
      : {
          // The quality gate's "<target>/<check>: detail" form (client failure-reasons.ts).
          errorReason: `quality_failed: ${[...new Set(failing.map((i) => i.code))]
            .map((code) => {
              const slides = failing.filter((i) => i.code === code).map((i) => i.slide + 1);
              return `carousel/${code}: slide ${slides.join(', ')}`;
            })
            .join('; ')}`.slice(0, 2_000),
        },
  });
  log.info({ slides: composition.slides.length, passed }, 'carousel rendered');
  if (moved && passed) await autoApproveIfTrusted(deps, data);
  if (moved && passed) await notifyGenerationComplete(deps, data);
}

export async function onRenderCarouselFailed(
  data: ProjectJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  await failProject(deps.db, {
    projectId: data.projectId,
    runId: data.runId,
    reason: `carousel_render_error: ${reason}`,
  });
}
