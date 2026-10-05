import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  ConflictError,
  NotFoundError,
  PlatformError,
  QueueUnavailableError,
  ValidationError,
} from '../../errors';
import { logger } from '../../logger';
import type { TenantContext } from '../../tenant';
import { composeCaption } from '../platforms/captions';
import {
  noteCredentialFailure,
  publicationMetadata,
  resolveCredentials,
  type PublishingDeps,
} from '../platforms/publishing';
import { assertChannelAllowed } from '../billing/channels';
import { checkFormat, PLATFORM_RULES } from '../platforms/rules';
import { carouselComposition, carouselPublishProblems } from '../carousel/publishing';
import { currentRunId } from '../pipeline/project-state';
import { jobIds, type JobQueue } from '../queue/enqueue';
import type { PublishJobData } from '../queue/queues';
import type { PlanTier } from '../providers/router';
import { MAX_SCHEDULE_AHEAD_MS, MIN_SCHEDULE_LEAD_MS } from '../schedule-window';
import { PLATFORMS, toPlanTier } from './catalog';
import { preparePublicationCopy } from './post-copy';

// Publications (spec 8.4, BACKLOG 5.10–5.11): schedule or publish now, read, cancel, retry,
// take down. Validation happens here so a bad request is a 400, never a failed upload.

const PUBLISHABLE_PROJECT_STATES = [
  'APPROVED',
  'PUBLISHING',
  'PUBLISHED',
  'PARTIALLY_PUBLISHED',
] as const;

export const createPublicationInput = z.object({
  renderId: z.string().min(1).max(64),
  platform: z.enum(PLATFORMS),
  /** platform_connections id (any platform; Instagram / Facebook rows are registered by Core). */
  connectionId: z.string().min(1).max(64).optional(),
  /** Instagram / Facebook: the Meta account id of a Core-registered channel (alternative). */
  platformAccountId: z.string().min(1).max(128).optional(),
  caption: z.string().max(70_000).default(''),
  hashtags: z.array(z.string().max(100)).max(40).default([]),
  title: z.string().max(200).optional(),
  scheduledFor: z.iso.datetime().optional(),
  options: z
    .object({
      privacyLevel: z
        .enum(['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'])
        .optional(),
      privacyStatus: z.enum(['public', 'unlisted', 'private']).optional(),
    })
    .strict()
    .optional(),
});

export type CreatePublicationInput = z.infer<typeof createPublicationInput>;

export const listPublicationsQuery = z.object({
  /** Comma-separated states. */
  state: z
    .string()
    .max(200)
    .refine(
      (v) =>
        v
          .split(',')
          .every((s) =>
            ['SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED', 'TAKEN_DOWN'].includes(
              s,
            ),
          ),
      { message: 'Unknown publication state' },
    )
    .optional(),
  platform: z.enum(PLATFORMS).optional(),
  projectId: z.string().max(64).optional(),
  /** Calendar window on scheduledFor/publishedAt (spec 14.3). */
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** GET /publications (spec 8.4): the manage list and calendar. */
export async function listPublications(
  db: PrismaClient,
  organisationId: string,
  query: z.infer<typeof listPublicationsQuery>,
) {
  const window =
    query.from || query.to
      ? {
          ...(query.from && { gte: new Date(query.from) }),
          ...(query.to && { lt: new Date(query.to) }),
        }
      : undefined;
  const rows = await db.videoPublication.findMany({
    where: {
      organisationId,
      ...(query.state && {
        state: { in: query.state.split(',') as Prisma.EnumPublicationStateFilter['in'] },
      }),
      ...(query.platform && { platform: query.platform }),
      ...(query.projectId && { projectId: query.projectId }),
      ...(window && { OR: [{ scheduledFor: window }, { publishedAt: window }] }),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
    include: {
      project: { select: { id: true, name: true } },
      // 15.A8 (spec 14.3 "live view counts"): the latest cumulative snapshot.
      analytics: {
        orderBy: { bucketAt: 'desc' },
        take: 1,
        select: { views: true, likes: true, comments: true, bucketAt: true },
      },
    },
  });
  const page = rows.slice(0, query.limit).map(({ analytics, ...row }) => {
    const latest = analytics[0];
    return {
      ...row,
      latestMetrics: latest
        ? {
            views: latest.views,
            likes: latest.likes,
            comments: latest.comments,
            at: latest.bucketAt,
          }
        : null,
    };
  });
  return { data: page, nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null };
}

async function findPublication(db: PrismaClient, organisationId: string, id: string) {
  const publication = await db.videoPublication.findFirst({ where: { id, organisationId } });
  if (!publication) throw new NotFoundError('Publication not found');
  return publication;
}

export async function getPublication(db: PrismaClient, organisationId: string, id: string) {
  return findPublication(db, organisationId, id);
}

/** Who a publish job runs for: the organisation and its plan tier (queue priority only). */
export interface PublishScope {
  organisationId: string;
  planTier: PlanTier;
}

function scopeOf(tenant: TenantContext): PublishScope {
  return {
    organisationId: tenant.organisationId,
    planTier: toPlanTier(tenant.organisation.planTier),
  };
}

function jobData(
  scope: PublishScope,
  publication: { id: string; projectId: string },
  runId: string,
): PublishJobData {
  return {
    publicationId: publication.id,
    projectId: publication.projectId,
    organisationId: scope.organisationId,
    runId,
    planTier: scope.planTier,
  };
}

export async function createPublication(
  deps: {
    db: PrismaClient;
    queue: JobQueue;
    storage: PublishingDeps['storage'];
    now: () => number;
  },
  tenant: TenantContext,
  input: CreatePublicationInput,
  /**
   * Studio-initiated publications only (auto-publish / schedule / drip / month plan): the
   * caption is fitted to the platform (15.A9) and the hashtag minimum never fails (20.13).
   */
  extra: { captionTruncated?: boolean; studioInitiated?: boolean } = {},
) {
  const { db } = deps;
  const orgId = tenant.organisationId;
  const render = await db.videoRender.findFirst({
    where: { id: input.renderId, project: { organisationId: orgId, deletedAt: null } },
    include: { project: true },
  });
  if (!render) throw new NotFoundError('Render not found');
  if (!(PUBLISHABLE_PROJECT_STATES as readonly string[]).includes(render.project.state)) {
    throw new ConflictError(
      `Project must be approved before publishing (project is ${render.project.state})`,
    );
  }
  if (render.qualityCheckState !== 'PASSED' && render.qualityCheckState !== 'FORCE_APPROVED') {
    throw new ConflictError(`Render quality check is ${render.qualityCheckState}`);
  }
  // 21.6: a carousel render is a set of slide images with its own platform rules.
  const carousel = carouselComposition(render.composition);
  if (carousel) {
    const problems = carouselPublishProblems(input.platform, carousel.slides.length);
    if (problems.length)
      throw new ValidationError('This carousel cannot be published there', { problems });
  } else {
    const sizeBytes = await deps.storage.size(render.s3Bucket, render.s3Key);
    const problems = checkFormat(input.platform, {
      aspectRatio: render.aspectRatio,
      durationSec: render.durationSec,
      sizeBytes,
    });
    if (problems.length)
      throw new ValidationError('Render does not fit this platform', { problems });
  }
  // 20.13: the business + always hashtags are added and the list topped up to ≥ 5; a person's
  // request that still has too few (or too many) is a 400 (post-copy.ts).
  const copy = await preparePublicationCopy(db, render.project, input.platform, {
    caption: input.caption,
    hashtags: input.hashtags,
    studioInitiated: Boolean(extra.studioInitiated),
  });
  const composed = composeCaption(input.platform, {
    caption: copy.caption,
    hashtags: copy.hashtags,
    title: input.title,
  });
  const captionTruncated = Boolean(extra.captionTruncated) || copy.truncated;

  const rules = PLATFORM_RULES[input.platform];
  // Studio OAuth platforms name the connection; Instagram / Facebook may name it or give the
  // Meta account id of a channel PostMind Core registered (/api/studio/internal/channels).
  if (!input.connectionId && !(rules.credentials === 'meta' && input.platformAccountId))
    throw new ValidationError(
      rules.credentials === 'meta'
        ? `${input.platform} needs a connectionId or platformAccountId`
        : `${input.platform} needs a connectionId`,
    );
  const connection = await db.platformConnection.findFirst({
    where: {
      organisationId: orgId,
      platform: rules.connectionPlatform,
      ...(input.connectionId
        ? { id: input.connectionId }
        : { platformAccountId: input.platformAccountId }),
    },
  });
  if (!connection)
    throw new ValidationError(
      input.connectionId
        ? `connectionId is not a ${rules.connectionPlatform} connection in this organisation`
        : `platformAccountId is not a connected ${rules.connectionPlatform} account in this organisation`,
    );
  if (connection.state !== 'active')
    throw new ConflictError(`The ${rules.connectionPlatform} connection needs reconnecting`);
  // 21.5: only the channels the organisation pays for publish (billing/channels.ts).
  await assertChannelAllowed(db, orgId, rules.connectionPlatform, new Date(deps.now()));
  const platformAccountId = connection.platformAccountId;
  const connectionId = connection.id;

  let scheduledFor: Date | null = null;
  if (input.scheduledFor) {
    scheduledFor = new Date(input.scheduledFor);
    const lead = scheduledFor.getTime() - deps.now();
    if (lead < MIN_SCHEDULE_LEAD_MS || lead > MAX_SCHEDULE_AHEAD_MS) {
      throw new ValidationError('scheduledFor must be between 1 minute and 180 days from now');
    }
  }

  const publication = await db.$transaction(async (tx) => {
    // Serialise concurrent requests for the same (render, platform, account): without the lock,
    // two requests could both pass the duplicate check and post the video twice.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`publication:${render.id}:${input.platform}:${platformAccountId}`}, 0))`;
    const duplicate = await tx.videoPublication.findFirst({
      where: {
        renderId: render.id,
        platform: input.platform,
        platformAccountId,
        state: { in: ['SCHEDULED', 'PUBLISHING', 'PUBLISHED'] },
      },
      select: { id: true },
    });
    if (duplicate)
      throw new ConflictError('This render is already scheduled or published to that account', {
        publicationId: duplicate.id,
      });
    const created = await tx.videoPublication.create({
      data: {
        organisationId: orgId,
        projectId: render.projectId,
        renderId: render.id,
        platform: input.platform,
        platformAccountId,
        scheduledFor,
        state: 'SCHEDULED',
        caption: composed.text,
        hashtags: composed.hashtags,
        metadata: {
          connectionId,
          title: composed.title ?? null,
          rawCaption: copy.caption,
          options: input.options ?? {},
          requestedBy: tenant.userId,
          ...(captionTruncated && { captionTruncated: true }),
          ...(copy.toppedUp.length && { hashtagsToppedUp: copy.toppedUp }),
        } as Prisma.InputJsonValue,
      },
    });
    if (scheduledFor) {
      await tx.scheduledPublication.create({
        data: { publicationId: created.id, scheduledFor, state: 'PENDING' },
      });
    }
    await tx.videoProject.updateMany({
      where: {
        id: render.projectId,
        organisationId: orgId,
        state: { in: ['APPROVED', 'PUBLISHED', 'PARTIALLY_PUBLISHED'] },
      },
      data: { state: 'PUBLISHING' },
    });
    return created;
  });

  const data = jobData(scopeOf(tenant), publication, currentRunId(render.project) ?? 'publish');
  try {
    if (scheduledFor) {
      const jobId = jobIds.fireScheduled(data);
      // The fire job carries its time: a later reschedule (13.9) turns this job into a no-op.
      const fireData = { ...data, scheduledFor: scheduledFor.toISOString() };
      await deps.queue.add('fire-scheduled-publication', fireData, {
        jobId,
        delayMs: scheduledFor.getTime() - deps.now(),
      });
      await db.scheduledPublication.update({
        where: { publicationId: publication.id },
        data: { jobId },
      });
    } else {
      await deps.queue.add('publish-video', data, { jobId: jobIds.publishVideo(data, 0) });
    }
  } catch (err) {
    await rollBackUnqueued(db, publication.id, render.projectId, render.project.state, err);
    throw new QueueUnavailableError(QUEUE_DOWN_MESSAGE, { publicationId: publication.id });
  }
  return publication;
}

const QUEUE_DOWN_MESSAGE =
  'Publishing is temporarily unavailable. Nothing was posted or kept; try again in a moment.';

/** Project states createPublication / retryPublication move to PUBLISHING. */
const RESTORABLE_PROJECT_STATES = ['APPROVED', 'PUBLISHED', 'PARTIALLY_PUBLISHED'];

/**
 * The publication row is committed before its job is queued (so a crash between the two is found
 * by the lost-publications sweep, 17.2). When the queue itself refuses the job, the row has no job
 * and the caller gets an error: delete it and put the project back, so the same request can be
 * sent again (otherwise the retry hits "already scheduled"). If even the rollback fails, the row
 * stays SCHEDULED and the sweep re-drives it.
 */
async function rollBackUnqueued(
  db: PrismaClient,
  publicationId: string,
  projectId: string,
  previousProjectState: string,
  cause: unknown,
): Promise<void> {
  logger.error({ err: cause, publicationId, projectId }, 'publish job could not be queued');
  try {
    await db.$transaction(async (tx) => {
      await tx.scheduledPublication.deleteMany({ where: { publicationId } });
      await tx.videoPublication.deleteMany({ where: { id: publicationId, state: 'SCHEDULED' } });
      if (RESTORABLE_PROJECT_STATES.includes(previousProjectState)) {
        const inFlight = await tx.videoPublication.count({
          where: { projectId, state: { in: ['SCHEDULED', 'PUBLISHING'] } },
        });
        if (inFlight === 0)
          await tx.videoProject.updateMany({
            where: { id: projectId, state: 'PUBLISHING' },
            data: { state: previousProjectState as 'APPROVED' },
          });
      }
    });
  } catch (rollbackErr) {
    logger.error(
      { err: rollbackErr, publicationId },
      'rolling back an unqueued publication failed',
    );
  }
}

/** Cancel before it fires: the delayed job becomes a no-op (it checks state). */
export async function cancelPublication(db: PrismaClient, organisationId: string, id: string) {
  const publication = await findPublication(db, organisationId, id);
  const cancelled = await db.$transaction(async (tx) => {
    const updated = await tx.videoPublication.updateMany({
      where: { id, organisationId, state: 'SCHEDULED', scheduledFor: { not: null } },
      data: { state: 'CANCELLED' },
    });
    if (updated.count === 0) return false;
    await tx.scheduledPublication.updateMany({
      where: { publicationId: id, state: 'PENDING' },
      data: { state: 'CANCELLED' },
    });
    return true;
  });
  if (!cancelled) {
    throw new ConflictError(
      publication.state === 'SCHEDULED'
        ? 'Only scheduled publications can be cancelled; this one is already queued'
        : `Publication is ${publication.state}`,
    );
  }
  return findPublication(db, organisationId, id);
}

export async function retryPublication(
  deps: { db: PrismaClient; queue: JobQueue },
  tenant: TenantContext,
  id: string,
) {
  return retryPublicationFor(deps, scopeOf(tenant), id);
}

/**
 * Tenant-free core of retryPublication, shared with the operator re-drive (services/redrive.ts),
 * which acts on another organisation's publication without that organisation's Core context.
 */
export async function retryPublicationFor(
  deps: { db: PrismaClient; queue: JobQueue },
  scope: PublishScope,
  id: string,
) {
  const publication = await findPublication(deps.db, scope.organisationId, id);
  if (publication.state !== 'FAILED')
    throw new ConflictError(`Only FAILED publications can be retried (is ${publication.state})`);
  const project = await deps.db.videoProject.findFirstOrThrow({
    where: { id: publication.projectId, organisationId: scope.organisationId },
  });
  const moved = await deps.db.videoPublication.updateMany({
    where: { id, organisationId: scope.organisationId, state: 'FAILED' },
    // An explicit retry is the person confirming the post is not live: clear the upload marker
    // that publish-video uses to refuse re-uploading after an unknown outcome.
    data: {
      state: 'SCHEDULED',
      errorReason: null,
      errorCode: null,
      metadata: withoutUploadMarker(publication.metadata),
    },
  });
  if (moved.count === 0) throw new ConflictError('Publication changed concurrently');
  await deps.db.videoProject.updateMany({
    where: {
      id: publication.projectId,
      organisationId: scope.organisationId,
      state: { in: ['PUBLISHED', 'PARTIALLY_PUBLISHED'] },
    },
    data: { state: 'PUBLISHING' },
  });
  const data = jobData(scope, publication, currentRunId(project) ?? 'publish');
  try {
    await deps.queue.add('publish-video', data, {
      jobId: jobIds.publishVideo(data, publication.retryCount),
    });
  } catch (err) {
    logger.error({ err, publicationId: id }, 'publish retry could not be queued');
    // Put the post back as it was (FAILED, same reason) so the user can press Retry again.
    await deps.db.videoPublication
      .updateMany({
        where: { id, organisationId: scope.organisationId, state: 'SCHEDULED' },
        data: {
          state: 'FAILED',
          errorReason: publication.errorReason,
          errorCode: publication.errorCode,
          metadata: (publication.metadata ?? {}) as Prisma.InputJsonValue,
        },
      })
      .catch((rollbackErr: unknown) =>
        logger.error({ err: rollbackErr, publicationId: id }, 'restoring a failed post failed'),
      );
    if (RESTORABLE_PROJECT_STATES.includes(project.state) && project.state !== 'APPROVED')
      await deps.db.videoProject
        .updateMany({
          where: { id: project.id, organisationId: scope.organisationId, state: 'PUBLISHING' },
          data: { state: project.state as 'PUBLISHED' },
        })
        .catch(() => undefined);
    throw new QueueUnavailableError(QUEUE_DOWN_MESSAGE, { publicationId: id });
  }
  return findPublication(deps.db, scope.organisationId, id);
}

function withoutUploadMarker(metadata: Prisma.JsonValue | null): Prisma.InputJsonValue {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const { uploadStartedAt: _marker, ...rest } = metadata as Record<string, Prisma.JsonValue>;
  return rest as Prisma.InputJsonValue;
}

function takedownMessage(platform: string, errorClass: string): string {
  switch (errorClass) {
    case 'needs_reconnect':
      return `Takedown failed: the ${platform} connection needs reconnecting`;
    case 'rate_limited':
    case 'quota_exceeded':
      return `Takedown failed: ${platform} is rate limiting requests; try again shortly`;
    case 'invalid_request':
      return `Takedown failed: ${platform} rejected the delete request for this post`;
    default:
      return `Takedown failed: ${platform} refused the request (${errorClass})`;
  }
}

/** Spec 8.4: "Not all platforms support programmatic delete; will fail cleanly with reason." */
export async function takedownPublication(
  deps: PublishingDeps,
  organisationId: string,
  id: string,
) {
  const publication = await findPublication(deps.db, organisationId, id);
  if (publication.state !== 'PUBLISHED' || !publication.platformPostId) {
    throw new ConflictError(`Only published posts can be taken down (is ${publication.state})`);
  }
  const publisher = deps.publishers[publication.platform as (typeof PLATFORMS)[number]];
  if (!publisher?.takedown) {
    throw new ConflictError(
      `${publication.platform} has no documented delete API; remove the post in the ${publication.platform} app`,
    );
  }
  const { accessToken, accountId } = await resolveCredentials(deps, publication);
  try {
    await publisher.takedown({
      accessToken,
      accountId,
      platformPostId: publication.platformPostId,
    });
  } catch (err) {
    await noteCredentialFailure(deps, publication, err);
    if (err instanceof PlatformError) {
      // The platform's own error text stays in the server log; callers get a curated message.
      deps.logger.warn({ err, publicationId: id }, 'takedown refused by platform');
      throw new ConflictError(takedownMessage(publication.platform, err.errorClass), {
        errorClass: err.errorClass,
      });
    }
    throw err;
  }
  await deps.db.videoPublication.update({
    where: { id },
    data: {
      state: 'TAKEN_DOWN',
      metadata: {
        ...publicationMetadata(publication),
        takenDownAt: new Date(deps.now()).toISOString(),
      } as Prisma.InputJsonValue,
    },
  });
  return findPublication(deps.db, organisationId, id);
}
