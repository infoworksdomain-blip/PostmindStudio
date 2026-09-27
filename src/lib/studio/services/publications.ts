import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, NotFoundError, PlatformError, ValidationError } from '../../errors';
import type { TenantContext } from '../../tenant';
import { composeCaption } from '../platforms/captions';
import {
  publicationMetadata,
  resolveCredentials,
  type PublishingDeps,
} from '../platforms/publishing';
import { checkFormat, PLATFORM_RULES } from '../platforms/rules';
import { currentRunId } from '../pipeline/project-state';
import { jobIds, type JobQueue } from '../queue/enqueue';
import type { PublishJobData } from '../queue/queues';
import { PLATFORMS, toPlanTier } from './catalog';

// Publications (spec 8.4, BACKLOG 5.10–5.11): schedule or publish now, read, cancel, retry,
// take down. Validation happens here so a bad request is a 400, never a failed upload.

const PUBLISHABLE_PROJECT_STATES = [
  'APPROVED',
  'PUBLISHING',
  'PUBLISHED',
  'PARTIALLY_PUBLISHED',
] as const;
const MIN_SCHEDULE_LEAD_MS = 60_000;
const MAX_SCHEDULE_AHEAD_MS = 180 * 24 * 60 * 60 * 1000;

export const createPublicationInput = z.object({
  renderId: z.string().min(1).max(64),
  platform: z.enum(PLATFORMS),
  /** Studio platform connection (TikTok, YouTube, X, LinkedIn). */
  connectionId: z.string().min(1).max(64).optional(),
  /** Engagement channel account id (Instagram / Facebook), spec 9.3. */
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
    include: { project: { select: { id: true, name: true } } },
  });
  const page = rows.slice(0, query.limit);
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

function jobData(
  tenant: TenantContext,
  publication: { id: string; projectId: string },
  runId: string,
): PublishJobData {
  return {
    publicationId: publication.id,
    projectId: publication.projectId,
    organisationId: tenant.organisationId,
    runId,
    planTier: toPlanTier(tenant.organisation.planTier),
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
  const sizeBytes = await deps.storage.size(render.s3Bucket, render.s3Key);
  const problems = checkFormat(input.platform, {
    aspectRatio: render.aspectRatio,
    durationSec: render.durationSec,
    sizeBytes,
  });
  if (problems.length) throw new ValidationError('Render does not fit this platform', { problems });
  const composed = composeCaption(input.platform, {
    caption: input.caption,
    hashtags: input.hashtags,
    title: input.title,
  });

  const rules = PLATFORM_RULES[input.platform];
  let platformAccountId: string;
  let connectionId: string | undefined;
  if (rules.credentials === 'studio') {
    if (!input.connectionId) throw new ValidationError(`${input.platform} needs a connectionId`);
    const connection = await db.platformConnection.findFirst({
      where: { id: input.connectionId, organisationId: orgId, platform: rules.connectionPlatform },
    });
    if (!connection)
      throw new ValidationError(
        `connectionId is not a ${rules.connectionPlatform} connection in this organisation`,
      );
    if (connection.state !== 'active')
      throw new ConflictError(`The ${rules.connectionPlatform} connection needs reconnecting`);
    platformAccountId = connection.platformAccountId;
    connectionId = connection.id;
  } else {
    if (!input.platformAccountId)
      throw new ValidationError(`${input.platform} needs the Engagement platformAccountId`);
    platformAccountId = input.platformAccountId;
  }

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
          connectionId: connectionId ?? null,
          title: composed.title ?? null,
          rawCaption: input.caption,
          options: input.options ?? {},
          requestedBy: tenant.userId,
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

  const data = jobData(tenant, publication, currentRunId(render.project) ?? 'publish');
  if (scheduledFor) {
    const jobId = jobIds.fireScheduled(data);
    await deps.queue.add('fire-scheduled-publication', data, {
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
  return publication;
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
  const publication = await findPublication(deps.db, tenant.organisationId, id);
  if (publication.state !== 'FAILED')
    throw new ConflictError(`Only FAILED publications can be retried (is ${publication.state})`);
  const project = await deps.db.videoProject.findFirstOrThrow({
    where: { id: publication.projectId, organisationId: tenant.organisationId },
  });
  const moved = await deps.db.videoPublication.updateMany({
    where: { id, organisationId: tenant.organisationId, state: 'FAILED' },
    data: { state: 'SCHEDULED', errorReason: null, errorCode: null },
  });
  if (moved.count === 0) throw new ConflictError('Publication changed concurrently');
  await deps.db.videoProject.updateMany({
    where: {
      id: publication.projectId,
      organisationId: tenant.organisationId,
      state: { in: ['PUBLISHED', 'PARTIALLY_PUBLISHED'] },
    },
    data: { state: 'PUBLISHING' },
  });
  const data = jobData(tenant, publication, currentRunId(project) ?? 'publish');
  await deps.queue.add('publish-video', data, {
    jobId: jobIds.publishVideo(data, publication.retryCount),
  });
  return findPublication(deps.db, tenant.organisationId, id);
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
