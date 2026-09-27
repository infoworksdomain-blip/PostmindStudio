import { randomUUID } from 'node:crypto';
import {
  VideoProjectState as VideoProjectStateEnum,
  type Prisma,
  type PrismaClient,
  type VideoProjectState,
} from '@prisma/client';
import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import type { TenantContext } from '../../tenant';
import { ACTIVE_PIPELINE_STATES, projectMetadata } from '../pipeline/project-state';
import { createPrismaProviderJobRepository } from '../providers/job-repository';
import type { ProviderRegistry } from '../providers/registry';
import { cancelTracked } from '../providers/tracked';
import { jobIds, type JobQueue } from '../queue/enqueue';
import type { ProjectJobData } from '../queue/queues';
import { assertModeAllowed } from '../library/blueprint';
import { slideshowInput } from '../slideshow/planner';
import { targetFormatInput, toPlanTier, toStoredFormats } from './catalog';
import { insertSlides, planSlideshowSlides } from './slideshows';

// Project lifecycle services behind /api/studio/projects (spec 8.2, BACKLOG 4.1–4.8).
// Every query is scoped by organisationId; another organisation's project is simply not found.

export const GENERATABLE_STATES: VideoProjectState[] = [
  'DRAFT',
  'FAILED',
  'REJECTED',
  'QUALITY_FAILED',
  'READY_FOR_REVIEW',
];
const EDITABLE_STATES: VideoProjectState[] = [
  'DRAFT',
  'FAILED',
  'REJECTED',
  'QUALITY_FAILED',
  'READY_FOR_REVIEW',
];

const briefInput = z.object({
  rawInput: z.string().trim().min(1).max(4_000),
  targetAudience: z.string().max(500).optional(),
  callToAction: z.string().max(200).optional(),
});

const projectFields = z.object({
  name: z.string().trim().min(1).max(200),
  businessId: z.string().trim().min(1).max(128),
  sourceType: z
    .enum(['BRIEF', 'POSTMIND_CONTENT', 'SLIDESHOW', 'LIBRARY_REFERENCE'])
    .default('BRIEF'),
  /** LIBRARY_REFERENCE (A3.9): the reference video and how it is used. */
  referenceVideoId: z.string().trim().min(1).max(64).optional(),
  referenceMode: z.enum(['TEMPLATE', 'INSPIRE']).optional(),
  sourceRef: z.string().max(200).optional(),
  /** Required for BRIEF / POSTMIND_CONTENT. */
  brief: briefInput.optional(),
  /** Required for SLIDESHOW (A8.5): templateId + inputs, or explicit slides. */
  slideshow: slideshowInput.optional(),
  targetFormats: z.array(targetFormatInput).min(1).max(10),
  brandKitId: z.string().max(64).optional(),
  templateId: z.string().max(64).optional(),
  costBudgetPence: z.number().int().min(0).max(10_000_000).optional(),
  reviewPolicy: z
    .enum(['AUTO_APPROVE', 'REQUIRE_APPROVAL', 'REQUIRE_APPROVAL_FROM_ROLE'])
    .optional(),
  publishPolicy: z.enum(['MANUAL', 'SCHEDULED', 'AUTO_ON_APPROVAL']).optional(),
  scheduledStartAt: z.iso.datetime().optional(),
});

export const createProjectInput = projectFields.superRefine((v, ctx) => {
  if (v.sourceType === 'SLIDESHOW' && !v.slideshow)
    ctx.addIssue({
      code: 'custom',
      path: ['slideshow'],
      message: 'slideshow is required for SLIDESHOW projects',
    });
  if (v.sourceType === 'LIBRARY_REFERENCE' && !(v.referenceVideoId && v.referenceMode))
    ctx.addIssue({
      code: 'custom',
      path: ['referenceVideoId'],
      message: 'referenceVideoId and referenceMode are required for LIBRARY_REFERENCE',
    });
  if (v.sourceType !== 'SLIDESHOW' && !v.brief)
    ctx.addIssue({ code: 'custom', path: ['brief'], message: 'brief is required' });
});

export const updateProjectInput = projectFields
  .pick({
    name: true,
    targetFormats: true,
    costBudgetPence: true,
    reviewPolicy: true,
    publishPolicy: true,
  })
  .partial()
  .extend({
    brief: briefInput.partial().optional(),
    brandKitId: z.string().max(64).nullable().optional(),
    scheduledStartAt: z.iso.datetime().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

const PROJECT_STATES = new Set<string>(Object.values(VideoProjectStateEnum));

export const listProjectsQuery = z.object({
  /** Comma-separated VideoProjectState values. */
  state: z
    .string()
    .max(500)
    .refine((v) => v.split(',').every((s) => PROJECT_STATES.has(s)), {
      message: 'Unknown project state',
    })
    .optional(),
  businessId: z.string().max(128).optional(),
  days: z.coerce.number().int().min(1).max(3650).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(64).optional(),
});

export const generateInput = z.object({
  /** Replace the brief text for this generation. */
  rawInput: z.string().trim().min(1).max(4_000).optional(),
  /** Spec 13.3: the user confirms restricted topics flagged at ideation. */
  confirmRestrictedTopics: z.boolean().optional(),
});

export const rejectInput = z.object({ note: z.string().trim().min(1).max(2_000) });
export const approveInput = z.object({ note: z.string().trim().max(2_000).optional() });

type Db = PrismaClient;

async function assertBrandKit(
  db: Db,
  organisationId: string,
  brandKitId: string | null | undefined,
) {
  if (!brandKitId) return;
  const kit = await db.brandKit.findFirst({
    where: { id: brandKitId, organisationId },
    select: { id: true },
  });
  if (!kit) throw new ValidationError('brandKitId does not exist in this organisation');
}

export async function findProject(db: Db, organisationId: string, id: string) {
  const project = await db.videoProject.findFirst({
    where: { id, organisationId, deletedAt: null },
  });
  if (!project) throw new NotFoundError('Project not found');
  return project;
}

export async function createProject(
  db: Db,
  tenant: TenantContext,
  input: z.infer<typeof createProjectInput>,
) {
  await assertBrandKit(db, tenant.organisationId, input.brandKitId);
  if (input.sourceType === 'LIBRARY_REFERENCE' && input.referenceVideoId && input.referenceMode) {
    const reference = await db.videoLibraryItem.findFirst({
      where: { id: input.referenceVideoId, retiredAt: null },
      include: { license: true, analysis: { select: { id: true } } },
    });
    if (!reference?.analysis)
      throw new ValidationError('referenceVideoId is not an available library video');
    assertModeAllowed(input.referenceMode, reference.license, Date.now());
  }
  const slideshow =
    input.sourceType === 'SLIDESHOW' && input.slideshow
      ? await planSlideshowSlides(
          db,
          { organisationId: tenant.organisationId, businessId: input.businessId },
          input.slideshow,
        )
      : undefined;
  return db.$transaction(async (tx) => {
    const project = await tx.videoProject.create({
      data: {
        organisationId: tenant.organisationId,
        businessId: input.businessId,
        createdByUserId: tenant.userId,
        name: input.name,
        description: input.brief?.rawInput ?? input.slideshow?.topic ?? null,
        state: 'DRAFT',
        sourceType: input.sourceType,
        sourceRef: input.sourceRef ?? null,
        ...(input.sourceType === 'LIBRARY_REFERENCE' && {
          referenceVideoId: input.referenceVideoId ?? null,
          referenceMode: input.referenceMode ?? null,
        }),
        targetFormats: toStoredFormats(input.targetFormats),
        brandKitId: input.brandKitId ?? null,
        templateId: input.templateId ?? null,
        costBudgetPence: input.costBudgetPence ?? null,
        reviewPolicy: input.reviewPolicy,
        publishPolicy: input.publishPolicy,
        scheduledStartAt: input.scheduledStartAt ? new Date(input.scheduledStartAt) : null,
        metadata: {
          briefHints: {
            targetAudience: input.brief?.targetAudience ?? null,
            callToAction: input.brief?.callToAction ?? null,
          },
          ...(slideshow && {
            slideshow: {
              templateId: slideshow.templateId,
              topic: input.slideshow?.topic ?? null,
            },
          }),
        },
      },
    });
    if (slideshow) await insertSlides(tx, project.id, slideshow.drafts);
    return project;
  });
}

export async function listProjects(
  db: Db,
  organisationId: string,
  query: z.infer<typeof listProjectsQuery>,
  now: number,
) {
  const where: Prisma.VideoProjectWhereInput = { organisationId, deletedAt: null };
  if (query.state) {
    const states = query.state.split(',') as VideoProjectState[];
    where.state = { in: states };
  }
  if (query.businessId) where.businessId = query.businessId;
  if (query.days) where.createdAt = { gte: new Date(now - query.days * 86_400_000) };
  const rows = await db.videoProject.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
  });
  const hasMore = rows.length > query.limit;
  const data = hasMore ? rows.slice(0, query.limit) : rows;
  return { data, nextCursor: hasMore ? (data.at(-1)?.id ?? null) : null, hasMore };
}

export async function getProjectDetail(db: Db, organisationId: string, id: string) {
  const project = await db.videoProject.findFirst({
    where: { id, organisationId, deletedAt: null },
    include: {
      brief: true,
      scripts: {
        orderBy: { createdAt: 'asc' },
        include: {
          shots: {
            orderBy: { sortOrder: 'asc' },
            select: {
              id: true,
              sortOrder: true,
              durationSec: true,
              visualTreatment: true,
              state: true,
              errorReason: true,
            },
          },
        },
      },
      renders: { orderBy: { createdAt: 'desc' } },
      publications: { orderBy: { createdAt: 'desc' } },
      approvals: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!project) throw new NotFoundError('Project not found');
  return project;
}

export async function updateProject(
  db: Db,
  organisationId: string,
  id: string,
  input: z.infer<typeof updateProjectInput>,
) {
  const project = await findProject(db, organisationId, id);
  if (!EDITABLE_STATES.includes(project.state)) {
    throw new ConflictError(`Project cannot be edited while ${project.state}`);
  }
  await assertBrandKit(db, organisationId, input.brandKitId);
  const metadata = projectMetadata(project.metadata);
  const hints = (metadata.briefHints as Record<string, unknown>) ?? {};
  const result = await db.videoProject.updateMany({
    where: { id, organisationId, state: project.state, updatedAt: project.updatedAt },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.brief?.rawInput !== undefined && { description: input.brief.rawInput }),
      ...(input.targetFormats && { targetFormats: toStoredFormats(input.targetFormats) }),
      ...(input.brandKitId !== undefined && { brandKitId: input.brandKitId }),
      ...(input.costBudgetPence !== undefined && { costBudgetPence: input.costBudgetPence }),
      ...(input.reviewPolicy && { reviewPolicy: input.reviewPolicy }),
      ...(input.publishPolicy && { publishPolicy: input.publishPolicy }),
      ...(input.scheduledStartAt !== undefined && {
        scheduledStartAt: input.scheduledStartAt ? new Date(input.scheduledStartAt) : null,
      }),
      ...(input.brief &&
        (input.brief.targetAudience !== undefined || input.brief.callToAction !== undefined) && {
          metadata: {
            ...metadata,
            briefHints: {
              ...hints,
              ...(input.brief.targetAudience !== undefined && {
                targetAudience: input.brief.targetAudience,
              }),
              ...(input.brief.callToAction !== undefined && {
                callToAction: input.brief.callToAction,
              }),
            },
          } as Prisma.InputJsonValue,
        }),
    },
  });
  if (result.count === 0) throw new ConflictError('Project changed concurrently; reload and retry');
  return findProject(db, organisationId, id);
}

export async function archiveProject(db: Db, organisationId: string, id: string, now: number) {
  const project = await findProject(db, organisationId, id);
  if (ACTIVE_PIPELINE_STATES.includes(project.state)) {
    throw new ConflictError('Cancel generation before archiving');
  }
  const archived = await db.videoProject.updateMany({
    where: { id, organisationId, state: project.state },
    data: { state: 'ARCHIVED', deletedAt: new Date(now) },
  });
  if (archived.count === 0)
    throw new ConflictError('Project changed concurrently; reload and retry');
}

export async function duplicateProject(db: Db, tenant: TenantContext, id: string) {
  const source = await findProject(db, tenant.organisationId, id);
  const hints = projectMetadata(source.metadata).briefHints;
  return db.videoProject.create({
    data: {
      organisationId: source.organisationId,
      businessId: source.businessId,
      createdByUserId: tenant.userId,
      name: `${source.name} (copy)`.slice(0, 200),
      description: source.description,
      state: 'DRAFT',
      sourceType: source.sourceType,
      sourceRef: source.sourceRef,
      targetFormats: source.targetFormats as Prisma.InputJsonValue,
      brandKitId: source.brandKitId,
      templateId: source.templateId,
      costBudgetPence: source.costBudgetPence,
      reviewPolicy: source.reviewPolicy,
      publishPolicy: source.publishPolicy,
      metadata: {
        duplicatedFrom: source.id,
        ...(hints ? { briefHints: hints as Prisma.InputJsonValue } : {}),
      },
    },
  });
}

/** Start a new run: new runId (older jobs become no-ops), state QUEUED, enqueue plan-project. */
export async function generateProject(
  deps: { db: Db; queue: JobQueue },
  tenant: TenantContext,
  id: string,
  input: z.infer<typeof generateInput>,
) {
  const project = await findProject(deps.db, tenant.organisationId, id);
  if (!GENERATABLE_STATES.includes(project.state)) {
    throw new ConflictError(`Project is ${project.state}; cancel it or wait for it to finish`);
  }
  const runId = randomUUID();
  const metadata = projectMetadata(project.metadata);
  const updated = await deps.db.videoProject.updateMany({
    where: {
      id,
      organisationId: tenant.organisationId,
      state: project.state,
      updatedAt: project.updatedAt,
    },
    data: {
      state: 'QUEUED',
      errorReason: null,
      completedAt: null,
      ...(input.rawInput && { description: input.rawInput }),
      metadata: {
        ...metadata,
        runId,
        renders: {},
        ...(input.confirmRestrictedTopics && { restrictedTopicsConfirmed: true }),
        directionOptions: undefined,
      } as Prisma.InputJsonValue,
    },
  });
  if (updated.count === 0)
    throw new ConflictError('Project changed concurrently; reload and retry');
  const planTier = toPlanTier(tenant.organisation.planTier);
  const job: ProjectJobData = {
    projectId: id,
    organisationId: tenant.organisationId,
    runId,
    planTier,
  };
  await deps.queue.add('plan-project', job, { jobId: jobIds.planProject(job) });
  return { runId, planTier };
}

/**
 * Cancel an in-flight run (spec 8.2): the run is superseded (its jobs become no-ops), in-flight
 * provider jobs are cancelled where the provider supports it, and the project is FAILED with
 * the cost incurred so far reported (not refunded).
 */
export async function cancelProject(
  deps: { db: Db; registry: ProviderRegistry; now: () => number },
  organisationId: string,
  id: string,
) {
  const project = await findProject(deps.db, organisationId, id);
  if (!ACTIVE_PIPELINE_STATES.includes(project.state)) {
    throw new ConflictError(`Project is ${project.state}; nothing to cancel`);
  }
  const metadata = projectMetadata(project.metadata);
  const updated = await deps.db.videoProject.updateMany({
    where: { id, organisationId, state: { in: [...ACTIVE_PIPELINE_STATES] } },
    data: {
      state: 'FAILED',
      errorReason: 'cancelled_by_user',
      metadata: {
        ...metadata,
        runId: `cancelled-${randomUUID()}`,
        cancelledRunId: metadata.runId ?? null,
      } as Prisma.InputJsonValue,
    },
  });
  if (updated.count === 0) throw new ConflictError('Project finished before it could be cancelled');

  const running = await deps.db.providerJob.findMany({
    where: { projectId: id, organisationId, state: 'RUNNING' },
  });
  const repo = createPrismaProviderJobRepository(deps.db);
  const cancelled: string[] = [];
  for (const job of running) {
    const adapter = deps.registry.findAdapter(job.provider);
    if (!adapter) continue;
    try {
      await cancelTracked(adapter, job.id, { organisationId }, { repo, now: deps.now });
      cancelled.push(job.id);
    } catch {
      // Best effort: the run is already superseded, so a late result is ignored either way.
    }
  }
  const after = await findProject(deps.db, organisationId, id);
  return { costIncurredPence: after.costActualPence, providerJobsCancelled: cancelled.length };
}

export async function approveProject(
  db: Db,
  tenant: TenantContext,
  id: string,
  note: string | undefined,
  now: number,
) {
  const project = await findProject(db, tenant.organisationId, id);
  if (project.state !== 'READY_FOR_REVIEW') {
    throw new ConflictError(
      `Only READY_FOR_REVIEW projects can be approved (project is ${project.state})`,
    );
  }
  await db.$transaction([
    db.videoProject.updateMany({
      where: { id, organisationId: tenant.organisationId, state: 'READY_FOR_REVIEW' },
      data: { state: 'APPROVED' },
    }),
    db.approvalTask.create({
      data: {
        projectId: id,
        stepIndex: 0,
        requiredRole: 'reviewer',
        state: 'APPROVED',
        resolvedByUserId: tenant.userId,
        note: note ?? null,
        resolvedAt: new Date(now),
      },
    }),
  ]);
  return findProject(db, tenant.organisationId, id);
}

export async function rejectProject(
  db: Db,
  tenant: TenantContext,
  id: string,
  note: string,
  now: number,
) {
  const project = await findProject(db, tenant.organisationId, id);
  if (project.state !== 'READY_FOR_REVIEW' && project.state !== 'QUALITY_FAILED') {
    throw new ConflictError(
      `Project is ${project.state}; only reviewable projects can be rejected`,
    );
  }
  await db.$transaction([
    db.videoProject.updateMany({
      where: { id, organisationId: tenant.organisationId, state: project.state },
      data: { state: 'REJECTED', errorReason: `rejected: ${note}`.slice(0, 2_000) },
    }),
    db.approvalTask.create({
      data: {
        projectId: id,
        stepIndex: 0,
        requiredRole: 'reviewer',
        state: 'REJECTED',
        resolvedByUserId: tenant.userId,
        note,
        resolvedAt: new Date(now),
      },
    }),
  ]);
  return findProject(db, tenant.organisationId, id);
}
