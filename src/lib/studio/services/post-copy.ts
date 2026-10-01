import type { Prisma, PrismaClient, VideoProject } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import { assembleHashtags, MIN_HASHTAGS, type AssembledHashtags } from '../hashtags/policy';
import { hashtagPool, projectCopy, type PlatformCopy, type ProfileWords } from '../hashtags/pool';
import { composeCaption, fitCaption, normaliseHashtags } from '../platforms/captions';
import { PLATFORM_RULES } from '../platforms/rules';
import { loadHashtagPolicy } from './business-hashtags';
import { formatPlatforms } from './caption-suggestions';
import { PLATFORMS, type Platform } from './catalog';

// 20.13 — a project's post copy (caption + hashtags + YouTube title) per platform, and the
// hashtag rule at publish time.
//   GET /api/studio/projects/:id/post-copy → the copy each platform will go out with: the owner's
//       edit (metadata.postCopy) or the generated suggestion (metadata.captionSuggestions) or
//       the brief's hook; hashtags always with the business + always-hashtags first.
//   PUT /api/studio/projects/:id/post-copy { platform, caption, hashtags[], title? } — the
//       owner's edit, used by Publish, auto-publish and the scheduled posts not yet sent.
// Publish time (createPublication): the business + always hashtags are added, a short list is
// topped up from the project's suggestions and the business profile; a person's request with
// fewer than 5 even then is a 400 (hashtags_minimum), Studio-initiated posts (auto-publish,
// schedule, drip, month plan) never fail on the count (the operator's "top up rather than fail").

type CopyDb = Pick<
  PrismaClient,
  'businessHashtagSettings' | 'business' | 'businessProfile' | 'videoBrief'
>;

export type CopySource = 'owner' | 'generated' | 'none';

export interface EffectivePostCopy extends PlatformCopy {
  source: CopySource;
  /** Business + always hashtags (cannot be removed; the business hashtag stays first). */
  locked: string[];
  min: number;
  max: number;
  captionMaxChars: number;
  captionLimitInBytes: boolean;
  /** Tags the platform appends itself (#Shorts), shown but never stored. */
  required: string[];
  titleMaxChars: number | null;
}

async function profileOf(db: CopyDb, project: Pick<VideoProject, 'organisationId' | 'businessId'>) {
  return db.businessProfile.findUnique({
    where: {
      organisationId_businessId: {
        organisationId: project.organisationId,
        businessId: project.businessId,
      },
    },
    select: {
      industry: true,
      subNiche: true,
      regions: true,
      products: true,
      services: true,
      audienceKeywords: true,
    },
  });
}

/**
 * The hashtags a publication carries: business + always first, then `chosen`, topped up to the
 * minimum from the project's suggestions, its brief keywords and the business profile.
 */
export async function publicationHashtags(
  db: CopyDb,
  project: Pick<VideoProject, 'id' | 'organisationId' | 'businessId' | 'metadata'>,
  platform: Platform,
  chosen: string[],
): Promise<AssembledHashtags> {
  const scope = { organisationId: project.organisationId, businessId: project.businessId };
  const [policy, profile, brief] = await Promise.all([
    loadHashtagPolicy(db, scope),
    profileOf(db, project),
    db.videoBrief.findUnique({ where: { projectId: project.id }, select: { keywords: true } }),
  ]);
  return assembleHashtags(platform, {
    policy,
    chosen,
    pool: hashtagPool(platform, {
      metadata: project.metadata,
      keywords: brief?.keywords,
      profile: profile as ProfileWords | null,
    }),
  });
}

/** The 400 for a request that cannot carry enough hashtags. */
export function hashtagsMinimumError(platform: Platform, assembled: AssembledHashtags) {
  return new ValidationError(
    `${platform} posts need at least ${assembled.limits.min} hashtags, including the business hashtag (${assembled.hashtags.length} available)`,
    {
      code: 'hashtags_minimum',
      platform,
      min: assembled.limits.min,
      count: assembled.hashtags.length,
    },
  );
}

export function hashtagsMaximumError(platform: Platform, assembled: AssembledHashtags) {
  return new ValidationError(
    `${platform} allows at most ${assembled.limits.max} hashtags, including the business and always-include hashtags`,
    { code: 'hashtags_maximum', platform, max: assembled.limits.max, dropped: assembled.dropped },
  );
}

/**
 * Hashtags + caption for createPublication. A person's request: 400 below the minimum or above
 * the maximum (their caption is never cut). Studio-initiated: never fails on the count, and the
 * caption is fitted to the platform limit (15.A9) after the hashtags are final.
 */
export async function preparePublicationCopy(
  db: CopyDb,
  project: Pick<VideoProject, 'id' | 'organisationId' | 'businessId' | 'metadata'>,
  platform: Platform,
  input: { caption: string; hashtags: string[]; studioInitiated: boolean },
): Promise<{ caption: string; hashtags: string[]; truncated: boolean; toppedUp: string[] }> {
  const chosen = input.studioInitiated
    ? normaliseLenient(input.hashtags)
    : normaliseHashtags(input.hashtags);
  const assembled = await publicationHashtags(db, project, platform, chosen);
  if (!input.studioInitiated) {
    if (assembled.dropped.length) throw hashtagsMaximumError(platform, assembled);
    if (assembled.short) throw hashtagsMinimumError(platform, assembled);
    return {
      caption: input.caption,
      hashtags: assembled.hashtags,
      truncated: false,
      toppedUp: assembled.toppedUp,
    };
  }
  const fitted = fitCaption(platform, { caption: input.caption, hashtags: assembled.hashtags });
  return {
    caption: fitted.caption,
    hashtags: assembled.hashtags,
    truncated: fitted.truncated,
    toppedUp: assembled.toppedUp,
  };
}

function normaliseLenient(tags: string[]): string[] {
  return tags.flatMap((t) => {
    try {
      return normaliseHashtags([t]);
    } catch {
      return [];
    }
  });
}

/** The caption and hashtags a Studio-initiated post of `platform` uses when none are given. */
export function storedCopyFor(
  metadata: Prisma.JsonValue | null,
  platform: Platform,
): PlatformCopy | null {
  const { owner, generated } = projectCopy(metadata);
  return owner[platform] ?? generated[platform] ?? null;
}

const projectSelect = {
  id: true,
  organisationId: true,
  businessId: true,
  metadata: true,
  targetFormats: true,
  brief: { select: { hook: true } },
} as const;

async function findProject(
  db: Pick<PrismaClient, 'videoProject'>,
  organisationId: string,
  id: string,
) {
  const project = await db.videoProject.findFirst({
    where: { id, organisationId, deletedAt: null },
    select: projectSelect,
  });
  if (!project) throw new NotFoundError('Project not found');
  return project;
}

function view(
  platform: Platform,
  copy: PlatformCopy,
  source: CopySource,
  assembled: AssembledHashtags,
): EffectivePostCopy {
  const rules = PLATFORM_RULES[platform];
  return {
    caption: copy.caption,
    hashtags: assembled.hashtags,
    ...(copy.title && { title: copy.title }),
    source,
    locked: assembled.locked,
    min: assembled.limits.min,
    max: assembled.limits.max,
    captionMaxChars: rules.captionMaxChars,
    captionLimitInBytes: rules.captionLimitInBytes ?? false,
    required: rules.requiredHashtags ?? [],
    titleMaxChars: rules.titleMaxChars ?? null,
  };
}

/** GET /projects/:id/post-copy. */
export async function getPostCopy(
  db: CopyDb & Pick<PrismaClient, 'videoProject'>,
  organisationId: string,
  projectId: string,
) {
  const project = await findProject(db, organisationId, projectId);
  const { owner, generated } = projectCopy(project.metadata);
  const platforms: Partial<Record<Platform, EffectivePostCopy>> = {};
  for (const platform of formatPlatforms(project.targetFormats)) {
    const source: CopySource = owner[platform]
      ? 'owner'
      : generated[platform]
        ? 'generated'
        : 'none';
    const copy = owner[platform] ??
      generated[platform] ?? { caption: project.brief?.hook ?? '', hashtags: [] };
    const assembled = await publicationHashtags(db, project, platform, copy.hashtags);
    platforms[platform] = view(platform, copy, source, assembled);
  }
  return { platforms, minHashtags: MIN_HASHTAGS };
}

export const postCopyInput = z
  .object({
    platform: z.enum(PLATFORMS),
    caption: z.string().max(10_000),
    hashtags: z.array(z.string().max(100)).max(40),
    title: z.string().max(200).optional(),
  })
  .strict();

/**
 * Validate an owner's copy for one platform (≥ 5 hashtags incl. the business hashtag after the
 * locked ones are added, ≤ the platform maximum, caption within the limit): 400 otherwise.
 */
export async function validateOwnerCopy(
  db: CopyDb,
  project: Pick<VideoProject, 'id' | 'organisationId' | 'businessId' | 'metadata'>,
  input: z.infer<typeof postCopyInput>,
): Promise<PlatformCopy & { assembled: AssembledHashtags }> {
  const chosen = normaliseHashtags(input.hashtags);
  const scope = { organisationId: project.organisationId, businessId: project.businessId };
  // The owner's edit is taken as written: no silent top-up of tags they removed.
  const assembled = assembleHashtags(input.platform, {
    policy: await loadHashtagPolicy(db, scope),
    chosen,
  });
  if (assembled.dropped.length) throw hashtagsMaximumError(input.platform, assembled);
  if (assembled.short) throw hashtagsMinimumError(input.platform, assembled);
  const caption = input.caption.trim();
  // Throws the 400 when caption + hashtags are over the platform limit.
  composeCaption(input.platform, {
    caption: caption || 'x',
    hashtags: assembled.hashtags,
    title: input.title || caption.split('\n')[0] || 'x',
  });
  return {
    caption,
    hashtags: assembled.hashtags,
    ...(input.title?.trim() && { title: input.title.trim() }),
    assembled,
  };
}

/** Store metadata.postCopy[platform] atomically (other platforms' edits are kept). */
export async function writeOwnerCopy(
  db: Pick<PrismaClient, '$executeRaw'>,
  projectId: string,
  platform: Platform,
  copy: PlatformCopy & { updatedAt: string; updatedBy: string },
): Promise<void> {
  await db.$executeRaw`
    UPDATE "studio"."video_projects"
    SET "metadata" = jsonb_set(
          COALESCE("metadata", '{}'::jsonb),
          '{postCopy}',
          COALESCE("metadata"->'postCopy', '{}'::jsonb) || jsonb_build_object(${platform}::text, ${JSON.stringify(copy)}::jsonb)
        ),
        "updatedAt" = now()
    WHERE "id" = ${projectId}`;
}

/**
 * Apply the owner's copy to the project's publications of `platform` that are still SCHEDULED
 * (not yet sent): "approved for publishing" posts go out with the edit. Returns how many.
 */
export async function applyCopyToScheduled(
  db: Pick<PrismaClient, 'videoPublication'>,
  projectId: string,
  platform: Platform,
  copy: PlatformCopy,
  now: number,
): Promise<number> {
  const scheduled = await db.videoPublication.findMany({
    where: { projectId, platform, state: 'SCHEDULED' },
    select: { id: true, metadata: true },
  });
  let updated = 0;
  for (const pub of scheduled) {
    const meta =
      pub.metadata && typeof pub.metadata === 'object' && !Array.isArray(pub.metadata)
        ? (pub.metadata as Record<string, unknown>)
        : {};
    const fitted = fitCaption(platform, copy);
    const composed = composeCaption(platform, {
      caption: fitted.caption,
      hashtags: copy.hashtags,
      title: copy.title ?? (typeof meta.title === 'string' ? meta.title : undefined),
    });
    const result = await db.videoPublication.updateMany({
      where: { id: pub.id, state: 'SCHEDULED' },
      data: {
        caption: composed.text,
        hashtags: composed.hashtags,
        metadata: {
          ...meta,
          rawCaption: fitted.caption,
          title: composed.title ?? null,
          copyEditedAt: new Date(now).toISOString(),
          ...(fitted.truncated && { captionTruncated: true }),
        } as Prisma.InputJsonValue,
      },
    });
    updated += result.count;
  }
  return updated;
}

/** PUT /projects/:id/post-copy. */
export async function putPostCopy(
  deps: { db: PrismaClient; now: () => number },
  tenant: { organisationId: string; userId: string },
  projectId: string,
  input: z.infer<typeof postCopyInput>,
) {
  const project = await findProject(deps.db, tenant.organisationId, projectId);
  if (!formatPlatforms(project.targetFormats).includes(input.platform))
    throw new ValidationError(`${input.platform} is not one of the project's formats`);
  const { assembled, ...copy } = await validateOwnerCopy(deps.db, project, input);
  await writeOwnerCopy(deps.db, project.id, input.platform, {
    ...copy,
    updatedAt: new Date(deps.now()).toISOString(),
    updatedBy: tenant.userId,
  });
  const scheduledUpdated = await applyCopyToScheduled(
    deps.db,
    project.id,
    input.platform,
    copy,
    deps.now(),
  );
  return { copy: view(input.platform, copy, 'owner', assembled), scheduledUpdated };
}

/** Plan items whose copy can still change (not sent, removed or given up). */
const EDITABLE_ITEM_STATUSES = new Set([
  'PLANNED',
  'QUEUED',
  'GENERATING',
  'READY',
  'SCHEDULED',
  'HELD',
]);

/**
 * PUT /content-plans/:id/items/:itemId/post-copy — the owner's copy of a planned post for one of
 * the plan's platforms. Stored on the item; once the item has a project, the project's copy and
 * its scheduled (not yet sent) posts change too (that needs publication:write, checked by the
 * caller through `mayChangePosts`).
 */
export async function putPlanItemCopy(
  deps: { db: PrismaClient; now: () => number },
  tenant: { organisationId: string; userId: string },
  plan: { id: string; organisationId: string; businessId: string; platforms: string[] },
  item: { id: string; status: string; projectId: string | null; postCopy: Prisma.JsonValue | null },
  input: z.infer<typeof postCopyInput>,
  mayChangePosts: boolean,
) {
  if (!plan.platforms.includes(input.platform))
    throw new ValidationError(`${input.platform} is not one of the plan's platforms`);
  if (!EDITABLE_ITEM_STATUSES.has(item.status))
    throw new ConflictError('This post can no longer be edited');
  if (item.projectId && !mayChangePosts)
    throw new ForbiddenError('Editing a generated post needs the publication:write capability', {
      capability: 'studio:publication:write',
    });
  const { assembled, ...copy } = await validateOwnerCopy(
    deps.db,
    {
      id: item.projectId ?? '',
      organisationId: plan.organisationId,
      businessId: plan.businessId,
      metadata: null,
    },
    input,
  );
  const current =
    item.postCopy && typeof item.postCopy === 'object' && !Array.isArray(item.postCopy)
      ? (item.postCopy as Record<string, unknown>)
      : {};
  await deps.db.contentPlanItem.update({
    where: { id: item.id },
    data: { postCopy: { ...current, [input.platform]: copy } as Prisma.InputJsonValue },
  });
  let scheduledUpdated = 0;
  if (item.projectId) {
    await writeOwnerCopy(deps.db, item.projectId, input.platform, {
      ...copy,
      updatedAt: new Date(deps.now()).toISOString(),
      updatedBy: tenant.userId,
    });
    scheduledUpdated = await applyCopyToScheduled(
      deps.db,
      item.projectId,
      input.platform,
      copy,
      deps.now(),
    );
  }
  return { copy: view(input.platform, copy, 'owner', assembled), scheduledUpdated };
}
