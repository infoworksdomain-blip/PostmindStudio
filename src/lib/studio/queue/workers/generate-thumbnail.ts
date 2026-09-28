import type { PipelineDeps } from '../../pipeline/deps';
import { projectMetadata } from '../../pipeline/project-state';
import { createFfmpegThumbnailComposer } from '../../services/thumbnail-composer';
import { generateRenderThumbnail, type ThumbnailDeps } from '../../services/thumbnails';
import type { ProjectJobData } from '../queues';

// 15.A3 — after composition, every render of the run without a thumbnail gets a generated
// candidate (A6.5: keyframe + hook text on the business's highest-engagement library image; the
// keyframe alone when the library is empty). Thumbnails are a nicety: a failure is logged and
// the render stays publishable (the person can upload or regenerate one from the variant card).

export function thumbnailDepsFrom(deps: PipelineDeps): ThumbnailDeps | null {
  const bucket = deps.publishing.thumbnailsBucket;
  if (!bucket) return null;
  return {
    db: deps.db,
    storage: deps.storage,
    composer: deps.thumbnails ?? createFfmpegThumbnailComposer(),
    bucket,
    fontsBaseUrl: deps.config.fontsBaseUrl,
    now: deps.now,
  };
}

export async function generateThumbnails(data: ProjectJobData, deps: PipelineDeps): Promise<void> {
  const log = deps.logger.child({ projectId: data.projectId, organisationId: data.organisationId });
  const thumbs = thumbnailDepsFrom(deps);
  if (!thumbs) return log.warn('S3_BUCKET_THUMBNAILS not set; thumbnails skipped');
  const project = await deps.db.videoProject.findFirst({
    where: { id: data.projectId, organisationId: data.organisationId, deletedAt: null },
    select: { metadata: true },
  });
  if (!project) return log.info('project gone; thumbnails skipped');
  const ids = Object.values(
    (projectMetadata(project.metadata).renders as Record<string, string> | undefined) ?? {},
  );
  const renders = await deps.db.videoRender.findMany({
    where: { id: { in: ids }, projectId: data.projectId, thumbnailS3Key: null },
    select: { id: true },
  });
  let made = 0;
  for (const render of renders) {
    try {
      await generateRenderThumbnail(thumbs, data.organisationId, render.id, { source: 'auto' });
      made += 1;
    } catch (err) {
      log.warn({ err, renderId: render.id }, 'thumbnail generation failed');
    }
  }
  log.info({ made, of: renders.length }, 'thumbnails generated');
}

export async function onGenerateThumbnailsFailed(
  data: ProjectJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  deps.logger.warn(
    { projectId: data.projectId, reason },
    'thumbnail job failed; renders unaffected',
  );
}
