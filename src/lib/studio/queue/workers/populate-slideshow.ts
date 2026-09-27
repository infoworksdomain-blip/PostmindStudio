import type { Prisma, VideoProjectState } from '@prisma/client';
import { NotFoundError } from '../../../errors';
import { libraryDepsFrom } from '../../images/library';
import { trackUnsplashUse } from '../../images/stock';
import type { PipelineDeps } from '../../pipeline/deps';
import { projectMetadata } from '../../pipeline/project-state';
import { parseTargetFormats } from '../../pipeline/scripting';
import { populateSlideshow } from '../../slideshow/populate';
import type { ProjectJobData } from '../queues';

// BACKLOG 7.5 — auto-populate a slideshow (A5.5). The project is SCANNING while this runs and
// returns to the state it came from; runId is the populate id stored in metadata.populate.

interface PopulateMeta {
  id?: string;
  returnTo?: VideoProjectState;
}

function populateMeta(metadata: Prisma.JsonValue): PopulateMeta {
  const value = projectMetadata(metadata).populate;
  return value && typeof value === 'object' ? (value as PopulateMeta) : {};
}

async function finish(
  deps: PipelineDeps,
  data: ProjectJobData,
  patch: Record<string, unknown>,
): Promise<void> {
  const project = await deps.db.videoProject.findFirst({
    where: { id: data.projectId, organisationId: data.organisationId, state: 'SCANNING' },
  });
  if (!project) return;
  const meta = populateMeta(project.metadata);
  if (meta.id !== data.runId) return;
  await deps.db.videoProject.updateMany({
    where: { id: project.id, state: 'SCANNING', updatedAt: project.updatedAt },
    data: {
      state: meta.returnTo ?? 'DRAFT',
      metadata: {
        ...projectMetadata(project.metadata),
        populate: { ...meta, ...patch, finishedAt: new Date(deps.now()).toISOString() },
      } as Prisma.InputJsonValue,
    },
  });
}

/** Report an Unsplash image's use to its download_location (stored in licenseNotes). */
export function unsplashUseReporter(fetchImpl: typeof fetch, accessKey: string | undefined) {
  return async (item: { sourceProvider: string | null; licenseNotes: string | null }) => {
    if (item.sourceProvider !== 'unsplash' || !accessKey) return;
    const url = item.licenseNotes?.match(/track:(\S+)/)?.[1];
    if (url) await trackUnsplashUse(url, accessKey, fetchImpl).catch(() => undefined);
  };
}

export async function populateSlideshowJob(
  data: ProjectJobData,
  deps: PipelineDeps,
): Promise<void> {
  const project = await deps.db.videoProject.findFirst({
    where: { id: data.projectId, organisationId: data.organisationId },
  });
  if (!project) throw new NotFoundError('Project not found');
  if (project.state !== 'SCANNING' || populateMeta(project.metadata).id !== data.runId) {
    return deps.logger.info({ projectId: project.id }, 'stale populate-slideshow job ignored');
  }
  const format = parseTargetFormats(project.targetFormats)[0];
  const slideshow = projectMetadata(project.metadata).slideshow as { topic?: string } | undefined;
  const result = await populateSlideshow(
    {
      db: deps.db,
      library: libraryDepsFrom(deps),
      providers: deps,
      reportStockUse: unsplashUseReporter(deps.fetch, process.env.UNSPLASH_ACCESS_KEY),
    },
    {
      organisationId: data.organisationId,
      businessId: project.businessId,
      projectId: project.id,
      planTier: data.planTier,
    },
    {
      topic: slideshow?.topic ?? project.description ?? null,
      aspectRatio: format?.aspectRatio ?? '9:16',
    },
  );
  await finish(deps, data, { result });
  deps.logger.info({ projectId: project.id, ...result }, 'slideshow auto-populated');
}

export async function onPopulateSlideshowFailed(
  data: ProjectJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  await finish(deps, data, { error: reason.slice(0, 1_000) });
}
