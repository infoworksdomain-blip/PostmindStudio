import type { Prisma } from '@prisma/client';
import { NotFoundError, PlatformError } from '../../../errors';
import type { PipelineDeps } from '../../pipeline/deps';
import { publicationMetadata, resolveCredentials, videoSource } from '../../platforms/publishing';
import type { Platform } from '../../services/catalog';
import { jobIds } from '../enqueue';
import type { PublishJobData } from '../queues';

// BACKLOG 5.9 — publish one render to one platform account (spec 4.5 step 9, 9.2–9.7):
// SCHEDULED → PUBLISHING → PUBLISHED | FAILED; Engagement attribution; project roll-up to
// PUBLISHED / PARTIALLY_PUBLISHED once no publication of the project is still pending.

const PENDING_STATES = ['SCHEDULED', 'PUBLISHING'] as const;

/** Project roll-up: PUBLISHED if every non-cancelled publication succeeded, else PARTIALLY_PUBLISHED. */
export async function rollUpProject(
  deps: Pick<PipelineDeps, 'db'>,
  projectId: string,
  organisationId: string,
): Promise<void> {
  const pubs = await deps.db.videoPublication.findMany({
    where: { projectId, organisationId, state: { notIn: ['CANCELLED'] } },
    select: { state: true },
  });
  if (
    pubs.length === 0 ||
    pubs.some((p) => (PENDING_STATES as readonly string[]).includes(p.state))
  )
    return;
  const published = pubs.filter((p) => p.state === 'PUBLISHED' || p.state === 'TAKEN_DOWN').length;
  const state =
    published === pubs.length
      ? 'PUBLISHED'
      : published > 0
        ? 'PARTIALLY_PUBLISHED'
        : 'PARTIALLY_PUBLISHED';
  await deps.db.videoProject.updateMany({
    where: { id: projectId, organisationId, state: 'PUBLISHING' },
    data: { state, ...(state === 'PUBLISHED' && { completedAt: new Date() }) },
  });
}

export async function publishVideo(data: PublishJobData, deps: PipelineDeps): Promise<void> {
  const log = deps.logger.child({
    publicationId: data.publicationId,
    organisationId: data.organisationId,
  });
  const publication = await deps.db.videoPublication.findFirst({
    where: { id: data.publicationId, organisationId: data.organisationId },
    include: { render: true },
  });
  if (!publication) throw new NotFoundError('Publication not found');
  if (publication.state !== 'SCHEDULED' && publication.state !== 'PUBLISHING') {
    return log.info({ state: publication.state }, 'publication no longer pending; skipped');
  }
  // CAS SCHEDULED → PUBLISHING (a BullMQ retry of this same job finds it already PUBLISHING).
  if (publication.state === 'SCHEDULED') {
    const moved = await deps.db.videoPublication.updateMany({
      where: { id: publication.id, state: 'SCHEDULED' },
      data: { state: 'PUBLISHING', errorReason: null, errorCode: null },
    });
    if (moved.count === 0) return log.info('publication claimed by another worker; skipped');
  }

  const platform = publication.platform as Platform;
  const meta = publicationMetadata(publication);
  const { accessToken, accountId } = await resolveCredentials(deps.publishing, publication);
  const video = await videoSource(deps.publishing, publication.render);
  const result = await deps.publishing.publishers[platform].publish({
    video,
    text: publication.caption ?? '',
    caption: meta.rawCaption ?? publication.caption ?? '',
    hashtags: publication.hashtags,
    title: meta.title,
    accessToken,
    accountId,
    aiGenerated: true,
    options: meta.options,
  });

  await deps.db.videoPublication.update({
    where: { id: publication.id },
    data: {
      state: 'PUBLISHED',
      platformPostId: result.platformPostId,
      platformUrl: result.platformUrl,
      publishedAt: new Date(deps.now()),
      metadata: { ...meta, result: result.metadata } as Prisma.InputJsonValue,
    },
  });
  deps.audit({
    actorUserId: 'system:studio-publisher',
    organisationId: data.organisationId,
    action: 'studio.publication.published',
    resource: { type: 'video_publication', id: publication.id },
    metadata: { platform, platformPostId: result.platformPostId },
  });
  await deps.publishing.engagement.attributePublication({
    publicationId: publication.id,
    organisationId: data.organisationId,
    platform,
    platformPostId: result.platformPostId,
  });
  await rollUpProject(deps, publication.projectId, data.organisationId);
  // Spec 15.2: metrics polling starts 30 s after publish.
  const poll = { ...data, pollNumber: 0 };
  await deps.queue.add('poll-publication-analytics', poll, {
    jobId: jobIds.pollAnalytics(poll),
    delayMs: 30_000,
  });
  log.info({ platform, platformPostId: result.platformPostId }, 'published');
}

export async function onPublishVideoFailed(
  data: PublishJobData,
  deps: PipelineDeps,
  reason: string,
  err?: unknown,
): Promise<void> {
  const errorCode = err instanceof PlatformError ? err.errorClass : 'unknown';
  const updated = await deps.db.videoPublication.updateMany({
    where: {
      id: data.publicationId,
      organisationId: data.organisationId,
      state: { in: ['SCHEDULED', 'PUBLISHING'] },
    },
    data: {
      state: 'FAILED',
      errorReason: reason.slice(0, 2_000),
      errorCode,
      retryCount: { increment: 1 },
    },
  });
  if (updated.count > 0) {
    deps.audit({
      actorUserId: 'system:studio-publisher',
      organisationId: data.organisationId,
      action: 'studio.publication.failed',
      resource: { type: 'video_publication', id: data.publicationId },
      metadata: { errorCode, reason: reason.slice(0, 500) },
    });
  }
  await rollUpProject(deps, data.projectId, data.organisationId);
}

/** BACKLOG 5.11 — a scheduled publication's delayed job fired: hand it to the publish queue. */
export async function fireScheduledPublication(
  data: PublishJobData,
  deps: PipelineDeps,
): Promise<void> {
  const fired = await deps.db.scheduledPublication.updateMany({
    where: { publicationId: data.publicationId, state: 'PENDING' },
    data: { state: 'FIRED' },
  });
  if (fired.count === 0) return; // cancelled, or already fired
  const publication = await deps.db.videoPublication.findFirst({
    where: { id: data.publicationId, organisationId: data.organisationId, state: 'SCHEDULED' },
    select: { retryCount: true },
  });
  if (!publication) return;
  await deps.queue.add('publish-video', data, {
    jobId: jobIds.publishVideo(data, publication.retryCount),
  });
}

export async function onFireScheduledFailed(
  data: PublishJobData,
  deps: PipelineDeps,
  reason: string,
  err?: unknown,
): Promise<void> {
  await onPublishVideoFailed(data, deps, `scheduling failed: ${reason}`, err);
}
