import { randomInt, randomUUID } from 'node:crypto';
import {
  VideoProjectState as VideoProjectStateEnum,
  type Prisma,
  type PrismaClient,
  type VideoProject,
  type VideoProjectState,
  type VideoUpload,
} from '@prisma/client';
import { z } from 'zod';
import { ConflictError, NotFoundError, UpstreamServiceError, ValidationError } from '../../errors';
import type { TenantContext } from '../../tenant';
import { ACTIVE_PIPELINE_STATES, projectMetadata } from '../pipeline/project-state';
import { directionOptionsOf, isVagueBriefReason } from '../pipeline/vague-brief';
import { isRestrictedTopicsReason, pendingTopicsOf } from '../pipeline/restricted-topics';
import { createPrismaProviderJobRepository } from '../providers/job-repository';
import type { ProviderRegistry } from '../providers/registry';
import { cancelTracked } from '../providers/tracked';
import { jobIds, type JobQueue } from '../queue/enqueue';
import type { ProjectJobData } from '../queue/queues';
import { assertModeAllowed } from '../library/blueprint';
import { slideshowInput } from '../slideshow/planner';
import { carouselCreateInput, readCarousel } from '../carousel/document';
import { CAROUSEL_TARGET_FORMATS } from '../carousel/publishing';
import { initialCarousel } from './carousels';
import { targetFormatInput, toPlanTier, toStoredFormats } from './catalog';
import { assertTierGate } from './tier-gates';
import { budgetFormatsFromJson, defaultProjectBudgetPence } from '../cost/project-budget';
import { insertSlides, planSlideshowSlides } from './slideshows';
import { attachDemoUpload, attachSourceUpload } from './uploads';
import { resolveDemoUpload } from './demo-videos';
import { hookDemoCreateInput, newHookDemoDocument, readHookDemo } from '../formats/hook-demo';
import {
  newWallOfTextDocument,
  readWallOfText,
  wallOfTextCreateInput,
} from '../formats/wall-of-text';
import { applyTemplate } from './templates';
import { defaultReviewPolicyFor } from './org-policy';
import { approveWithWorkflow, rejectWithWorkflow } from './approval-workflows';
import {
  assertMayConfigureTargets,
  assertTargetsForPolicy,
  autoPublishTargets,
  storedTargets,
  validateTargets,
} from '../automation/targets';
import { generationStartMetadata } from '../observability/slo';
import { DEFAULT_LANGUAGE, extraLanguagesInput, languageInput } from '../languages';
import {
  effectiveTier,
  generateOverridesInput,
  validatePreferredProviders,
} from './generate-overrides';
import { isUntitledName } from '../../project-name';
import { isBeyondScheduleWindow, MAX_SCHEDULE_AHEAD_DAYS } from '../schedule-window';
import { MAX_UGC_SEED, newUgcStyle, ugcInput, ugcStyleOf } from '../ugc/style';
import { ugcProjectBudgetPence } from '../ugc/cost';
import { assertNoRealPerson, assertUgcProductImage, assertUgcShape } from '../ugc/validate';
import { ugcMetadata } from '../ugc/creator-ref';
import { recordCreatorUse, resolveProjectCreator } from './creators';

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
  /**
   * 17.9: optional — a project the user did not name (omitted or null; PATCH null clears it) is
   * stored with name null and shown as a translated "Untitled video"; the English placeholder
   * an older client sends is stored as null too.
   */
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .nullish()
    .transform((v) => (isUntitledName(v) ? null : (v as string))),
  businessId: z.string().trim().min(1).max(128),
  sourceType: z
    .enum([
      'BRIEF',
      'POSTMIND_CONTENT',
      'SLIDESHOW',
      'LIBRARY_REFERENCE',
      'TEMPLATE',
      'UPLOAD',
      'CAROUSEL',
      'HOOK_DEMO',
      'WALL_OF_TEXT',
    ])
    .default('BRIEF'),
  /** 21.6 CAROUSEL: theme, number of posts, an optional pasted thread and handle. */
  carousel: carouselCreateInput.optional(),
  /** 22.1 HOOK_DEMO: the demo video (default: the business's newest), hook line and layout. */
  hookDemo: hookDemoCreateInput.optional(),
  /** 22.2 WALL_OF_TEXT: the text block (default: Claude writes it), background and length. */
  wallOfText: wallOfTextCreateInput.optional(),
  /** UPLOAD (13.5): a READY source-video upload (POST /uploads, then /uploads/:id/complete). */
  uploadId: z.string().trim().min(1).max(64).optional(),
  /** LIBRARY_REFERENCE (A3.9): the reference video and how it is used. */
  referenceVideoId: z.string().trim().min(1).max(64).optional(),
  referenceMode: z.enum(['TEMPLATE', 'INSPIRE']).optional(),
  sourceRef: z.string().max(200).optional(),
  /** Required for BRIEF / POSTMIND_CONTENT. */
  brief: briefInput.optional(),
  /** Required for SLIDESHOW (A8.5): templateId + inputs, or explicit slides. */
  slideshow: slideshowInput.optional(),
  /** Required unless sourceType is TEMPLATE (then the template's formats are the default). */
  targetFormats: z.array(targetFormatInput).min(1).max(10).optional(),
  brandKitId: z.string().max(64).optional(),
  /** TEMPLATE: the project template (spec 8.6) to build from. */
  templateId: z.string().max(64).optional(),
  /** TEMPLATE: values for the template's {{variables}}. */
  templateVariables: z
    .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/), z.string().max(500))
    .refine((v) => Object.keys(v).length <= 20, { message: 'At most 20 template variables' })
    .optional(),
  /** publishPolicy AUTO_ON_APPROVAL: where to publish when approved (automation/targets.ts). */
  autoPublish: z.object({ targets: autoPublishTargets }).strict().optional(),
  costBudgetPence: z.number().int().min(0).max(10_000_000).optional(),
  reviewPolicy: z
    .enum(['AUTO_APPROVE', 'REQUIRE_APPROVAL', 'REQUIRE_APPROVAL_FROM_ROLE'])
    .optional(),
  publishPolicy: z.enum(['MANUAL', 'SCHEDULED', 'AUTO_ON_APPROVAL']).optional(),
  scheduledStartAt: z.iso.datetime().optional(),
  /** 15.C5: the video's language (BCP 47, one of languages.ts); default en-GB. */
  language: languageInput.optional(),
  /** 15.C5: extra languages; each gets its own set of scripts (one variant set per language). */
  languages: extraLanguagesInput.optional(),
  /** 15.C4 (spec 14.1): an approval workflow chosen at create (15.D3 reads metadata). */
  approvalWorkflowId: z.string().trim().min(1).max(64).optional(),
  /** 21.4: the "UGC actor" style (STANDARD and above): product and actor look, all optional. */
  ugc: ugcInput.optional(),
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
  if (v.sourceType === 'TEMPLATE' && !v.templateId)
    ctx.addIssue({
      code: 'custom',
      path: ['templateId'],
      message: 'templateId is required for TEMPLATE projects',
    });
  if (v.sourceType === 'UPLOAD' && !v.uploadId)
    ctx.addIssue({
      code: 'custom',
      path: ['uploadId'],
      message: 'uploadId is required for UPLOAD projects',
    });
  if (v.sourceType === 'CAROUSEL' && !v.carousel)
    ctx.addIssue({
      code: 'custom',
      path: ['carousel'],
      message: 'carousel is required for CAROUSEL projects',
    });
  if (v.hookDemo && v.sourceType !== 'HOOK_DEMO')
    ctx.addIssue({
      code: 'custom',
      path: ['hookDemo'],
      message: 'hookDemo is only for HOOK_DEMO projects',
    });
  if (v.wallOfText && v.sourceType !== 'WALL_OF_TEXT')
    ctx.addIssue({
      code: 'custom',
      path: ['wallOfText'],
      message: 'wallOfText is only for WALL_OF_TEXT projects',
    });
  if (v.ugc && (v.sourceType === 'HOOK_DEMO' || v.sourceType === 'WALL_OF_TEXT'))
    ctx.addIssue({ code: 'custom', path: ['ugc'], message: 'ugc is not used by this format' });
  // 21.6: a carousel needs a brief unless the owner pasted the thread itself.
  const pastedThread = v.sourceType === 'CAROUSEL' && Boolean(v.carousel?.thread?.trim());
  // 22.2: a wall of text needs a brief unless the owner wrote the text block itself.
  const ownText = v.sourceType === 'WALL_OF_TEXT' && Boolean(v.wallOfText?.text?.trim());
  // 22.1: a hook + demo video can be made from the business profile and the demo alone.
  if (
    !['SLIDESHOW', 'TEMPLATE', 'UPLOAD', 'HOOK_DEMO'].includes(v.sourceType) &&
    !v.brief &&
    !pastedThread &&
    !ownText
  )
    ctx.addIssue({ code: 'custom', path: ['brief'], message: 'brief is required' });
  // A carousel's destinations are fixed (CAROUSEL_COPY_FORMATS); it takes no targetFormats.
  if (!['TEMPLATE', 'CAROUSEL'].includes(v.sourceType) && !v.targetFormats)
    ctx.addIssue({ code: 'custom', path: ['targetFormats'], message: 'targetFormats is required' });
});

export const updateProjectInput = projectFields
  .pick({
    name: true,
    targetFormats: true,
    costBudgetPence: true,
    reviewPolicy: true,
    publishPolicy: true,
    autoPublish: true,
    language: true,
    languages: true,
  })
  .partial()
  .extend({
    brief: briefInput.partial().optional(),
    brandKitId: z.string().max(64).nullable().optional(),
    approvalWorkflowId: z.string().trim().min(1).max(64).nullable().optional(),
    scheduledStartAt: z.iso.datetime().nullable().optional(),
    /** 13.20: resume automatically when the org daily/monthly cap rolls over (default on). */
    autoResume: z.boolean().optional(),
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
  /** QA 3: free-text search over the name, description and brief (case-insensitive). */
  q: z.string().trim().max(200).optional(),
  days: z.coerce.number().int().min(1).max(3650).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(64).optional(),
});

export const generateInput = z.object({
  /** Replace the brief text for this generation. */
  rawInput: z.string().trim().min(1).max(4_000).optional(),
  /** Spec 13.3: the user confirms restricted topics flagged at ideation. */
  confirmRestrictedTopics: z.boolean().optional(),
  /**
   * 20.18: the owner chose one of the suggested directions (or rewrote the brief) after ideation
   * found it too vague. Stored for this run; ideation then treats the brief as actionable.
   */
  directionChosen: z.boolean().optional(),
  /** 15.C4 (spec 8.2): a lower quality tier for this run, and provider preferences. */
  ...generateOverridesInput,
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

/** 15.C4: a chosen approval workflow must exist in this organisation. */
async function assertWorkflow(db: Db, organisationId: string, id: string | null | undefined) {
  if (!id) return;
  const found = await db.approvalWorkflow.findFirst({
    where: { id, organisationId },
    select: { id: true },
  });
  if (!found) throw new ValidationError('approvalWorkflowId does not exist in this organisation');
}

/**
 * 20.3: a project's scheduledStartAt follows the publications rule — at most 180 days ahead
 * (a start in the past still means "as soon as approved", outbox.ts planSchedule).
 */
export function assertScheduledStartAt(value: string | null | undefined, now: number): void {
  if (!value) return;
  if (isBeyondScheduleWindow(Date.parse(value), now))
    throw new ValidationError(
      `scheduledStartAt must be at most ${MAX_SCHEDULE_AHEAD_DAYS} days from now`,
      { field: 'scheduledStartAt', maxDays: MAX_SCHEDULE_AHEAD_DAYS },
    );
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
  now: number = Date.now(),
) {
  assertScheduledStartAt(input.scheduledStartAt, now);
  await assertBrandKit(db, tenant.organisationId, input.brandKitId);
  await assertWorkflow(db, tenant.organisationId, input.approvalWorkflowId);
  if (input.ugc) {
    // 21.4: every active subscriber; short-form, English, from a brief, never a real person.
    assertUgcShape({
      sourceType: input.sourceType,
      formats: input.targetFormats ?? [],
      language: input.language,
      languages: input.languages,
    });
    assertNoRealPerson(input.brief?.rawInput, input.ugc.product?.name);
    await assertUgcProductImage(
      db,
      { organisationId: tenant.organisationId, businessId: input.businessId },
      input.ugc,
    );
  }
  // 22.3: a reusable creator of this business (READY, with a portrait) instead of a one-off actor.
  const creator = input.ugc?.creatorId
    ? await resolveProjectCreator(
        db,
        { organisationId: tenant.organisationId, businessId: input.businessId },
        input.ugc.creatorId,
      )
    : undefined;
  if (input.sourceType === 'LIBRARY_REFERENCE' && input.referenceVideoId && input.referenceMode) {
    // 15.D2 / A10.3: INSPIRE is Standard and above, TEMPLATE Plus and above.
    assertTierGate(
      tenant,
      input.referenceMode === 'TEMPLATE' ? 'library.template' : 'library.inspire',
    );
    const reference = await db.videoLibraryItem.findFirst({
      where: { id: input.referenceVideoId, retiredAt: null },
      include: { license: true, analysis: { select: { id: true } } },
    });
    if (!reference?.analysis)
      throw new ValidationError('referenceVideoId is not an available library video');
    assertModeAllowed(input.referenceMode, reference.license, Date.now());
  }
  const template =
    input.sourceType === 'TEMPLATE' && input.templateId
      ? await applyTemplate(db, tenant.organisationId, input.templateId, {
          businessId: input.businessId,
          targetFormats: input.targetFormats,
          brandKitId: input.brandKitId,
          reviewPolicy: input.reviewPolicy,
          publishPolicy: input.publishPolicy,
          autoPublishTargets: input.autoPublish?.targets,
          briefText: input.brief?.rawInput,
          variables: input.templateVariables,
        })
      : null;
  // 22.1 / 22.2: the format's own settings (defaults applied when the body left them out).
  const hookDemo =
    input.sourceType === 'HOOK_DEMO' ? hookDemoCreateInput.parse(input.hookDemo ?? {}) : null;
  const wallOfText =
    input.sourceType === 'WALL_OF_TEXT'
      ? wallOfTextCreateInput.parse(input.wallOfText ?? {})
      : null;
  // 22.1: no demo video, no hook + demo video (no_demo_video), checked before anything is stored.
  const demoUpload = hookDemo
    ? await resolveDemoUpload(db, {
        organisationId: tenant.organisationId,
        businessId: input.businessId,
        demoUploadId: hookDemo.demoUploadId,
      })
    : null;
  // These formats have a fixed length (the hook + demo target, the wall-of-text duration).
  const fixedSec = hookDemo?.targetSec ?? wallOfText?.durationSec;
  const formats =
    input.sourceType === 'CAROUSEL'
      ? CAROUSEL_TARGET_FORMATS
      : (template?.targetFormats ?? input.targetFormats ?? []).map((f) =>
          fixedSec ? { ...f, durationSec: fixedSec } : f,
        );
  const targets = template?.autoPublishTargets ?? input.autoPublish?.targets ?? [];
  // 20.12: auto-publish / a schedule the request asked for needs an account to post to (a
  // template's own publish defaults are the template's business).
  if (!template) assertTargetsForPolicy(input.publishPolicy, targets);
  assertMayConfigureTargets(tenant, targets);
  await validateTargets(
    db,
    tenant.organisationId,
    targets,
    formats.map((f) => f.platform),
  );
  const slideshow =
    input.sourceType === 'SLIDESHOW' && input.slideshow
      ? await planSlideshowSlides(
          db,
          { organisationId: tenant.organisationId, businessId: input.businessId },
          input.slideshow,
        )
      : undefined;
  const carousel =
    input.sourceType === 'CAROUSEL' && input.carousel
      ? await initialCarousel(db, {
          organisationId: tenant.organisationId,
          businessId: input.businessId,
          brandKitId: input.brandKitId,
          language: input.language ?? DEFAULT_LANGUAGE,
          carousel: input.carousel,
        })
      : undefined;
  const orgReviewPolicy = await defaultReviewPolicyFor(db, tenant.organisationId);
  return db.$transaction(async (tx) => {
    const project = await tx.videoProject.create({
      data: {
        organisationId: tenant.organisationId,
        businessId: input.businessId,
        createdByUserId: tenant.userId,
        name: input.name,
        description:
          template?.description ?? input.brief?.rawInput ?? input.slideshow?.topic ?? null,
        state: 'DRAFT',
        sourceType: input.sourceType,
        // UPLOAD: sourceRef is the upload (plan-upload.ts reads its asset from there). 22.1: a
        // hook + demo project's is its demo video (for reference; the bank keeps the upload).
        sourceRef:
          input.sourceType === 'UPLOAD'
            ? (input.uploadId ?? null)
            : (demoUpload?.id ?? input.sourceRef ?? null),
        ...(input.sourceType === 'LIBRARY_REFERENCE' && {
          referenceVideoId: input.referenceVideoId ?? null,
          referenceMode: input.referenceMode ?? null,
        }),
        targetFormats: toStoredFormats(formats),
        brandKitId: template?.brandKitId ?? input.brandKitId ?? null,
        templateId: input.templateId ?? null,
        // Operator decision 2: no explicit budget → the short/long-form default (20.25: per tier).
        costBudgetPence:
          input.costBudgetPence ??
          (input.ugc
            ? ugcProjectBudgetPence(toPlanTier(tenant.organisation.planTier))
            : defaultProjectBudgetPence(
                formats,
                input.sourceType,
                toPlanTier(tenant.organisation.planTier),
              )),
        // 13.18: nothing chosen (client or template) → the organisation's default policy.
        reviewPolicy: (template ? template.reviewPolicy : input.reviewPolicy) ?? orgReviewPolicy,
        publishPolicy: template ? template.publishPolicy : input.publishPolicy,
        scheduledStartAt: input.scheduledStartAt ? new Date(input.scheduledStartAt) : null,
        language: input.language ?? DEFAULT_LANGUAGE,
        metadata: {
          ...(input.approvalWorkflowId && { approvalWorkflowId: input.approvalWorkflowId }),
          ...(input.languages?.length && {
            languages: input.languages.filter((l) => l !== (input.language ?? DEFAULT_LANGUAGE)),
          }),
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
          ...(targets.length > 0 && { autoPublish: { targets } }),
          ...(template && { template: { id: template.templateId } }),
          ...(carousel && { carousel }),
          ...(wallOfText && { wallOfText: newWallOfTextDocument(wallOfText) }),
          ...(input.ugc && {
            ugc: ugcMetadata(
              newUgcStyle(input.ugc, randomInt(0, MAX_UGC_SEED), creator),
            ) as unknown as Prisma.InputJsonObject,
          }),
        } as Prisma.InputJsonValue,
      },
    });
    if (creator)
      await recordCreatorUse(
        tx,
        { organisationId: tenant.organisationId, businessId: input.businessId },
        creator.id,
        now,
      );
    if (slideshow) await insertSlides(tx, project.id, slideshow.drafts);
    if (input.sourceType === 'UPLOAD' && input.uploadId)
      await attachSourceUpload(tx, {
        organisationId: tenant.organisationId,
        businessId: input.businessId,
        uploadId: input.uploadId,
        projectId: project.id,
      });
    if (hookDemo && demoUpload) return attachHookDemo(tx, project, hookDemo, demoUpload);
    return project;
  });
}

/** 22.1: the project's own asset of the demo video, then metadata.hookDemo pointing at it. */
async function attachHookDemo(
  tx: Prisma.TransactionClient,
  project: VideoProject,
  input: z.infer<typeof hookDemoCreateInput>,
  demo: VideoUpload,
): Promise<VideoProject> {
  const { assetId } = await attachDemoUpload(tx, demo, project.id);
  return tx.videoProject.update({
    where: { id: project.id },
    data: {
      metadata: {
        ...projectMetadata(project.metadata),
        hookDemo: newHookDemoDocument(input, { uploadId: demo.id, assetId }),
      } as Prisma.InputJsonValue,
    },
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
  } else {
    // Archived projects have their own filter; the default list is the live work.
    where.state = { not: 'ARCHIVED' };
  }
  if (query.q) {
    const text = { contains: query.q, mode: 'insensitive' as const };
    where.OR = [
      { name: text },
      { description: text },
      { brief: { is: { OR: [{ rawInput: text }, { hook: text }, { keyMessage: text }] } } },
    ];
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
  return {
    ...project,
    directionOptions: projectDirectionOptions(project),
    pendingRestrictedTopics: projectPendingRestrictedTopics(project),
  };
}

/**
 * 20.18: the directions ideation suggested, while the project waits in DRAFT for the owner to
 * choose one (empty otherwise). Studio's own model output for the owner's brief, not provider
 * error text, so it is shown to customers.
 */
export function projectDirectionOptions(
  project: Pick<VideoProject, 'state' | 'errorReason' | 'metadata'>,
): string[] {
  if (project.state !== 'DRAFT' || !isVagueBriefReason(project.errorReason)) return [];
  return directionOptionsOf(projectMetadata(project.metadata).directionOptions);
}

/**
 * 20.18 (spec 13.3): the restricted topics ideation found, while the project waits in DRAFT for
 * the owner to confirm them or change the brief (empty otherwise). They come from the
 * organisation's own brand kit / business profile list, so they are shown to customers.
 */
export function projectPendingRestrictedTopics(
  project: Pick<VideoProject, 'state' | 'errorReason' | 'metadata'>,
): string[] {
  if (project.state !== 'DRAFT' || !isRestrictedTopicsReason(project.errorReason)) return [];
  return pendingTopicsOf(projectMetadata(project.metadata).pendingRestrictedTopics);
}

function storedPlatforms(targetFormats: Prisma.JsonValue): string[] {
  return Array.isArray(targetFormats)
    ? targetFormats.flatMap((f) =>
        f && typeof f === 'object' && !Array.isArray(f) && typeof f.platform === 'string'
          ? [f.platform]
          : [],
      )
    : [];
}

export async function updateProject(
  db: Db,
  tenant: Pick<TenantContext, 'organisationId' | 'capabilities'>,
  id: string,
  input: z.infer<typeof updateProjectInput>,
  now: number = Date.now(),
) {
  assertScheduledStartAt(input.scheduledStartAt, now);
  const { organisationId } = tenant;
  const project = await findProject(db, organisationId, id);
  // 13.20: the auto-resume opt-out alone may change in any state (e.g. while generating).
  const onlyAutoResume = Object.keys(input).every((k) => k === 'autoResume');
  if (!onlyAutoResume && !EDITABLE_STATES.includes(project.state)) {
    throw new ConflictError(`Project cannot be edited while ${project.state}`);
  }
  await assertBrandKit(db, organisationId, input.brandKitId);
  await assertWorkflow(db, organisationId, input.approvalWorkflowId);
  if (ugcStyleOf(project.metadata)) {
    // 21.4: an edited UGC project still meets the style's rules.
    assertUgcShape({
      sourceType: project.sourceType,
      formats: input.targetFormats ?? budgetFormatsFromJson(project.targetFormats),
      language: input.language ?? project.language,
      languages:
        input.languages ??
        (Array.isArray(projectMetadata(project.metadata).languages)
          ? (projectMetadata(project.metadata).languages as string[])
          : []),
    });
    assertNoRealPerson(input.brief?.rawInput);
  }
  if (input.autoPublish) {
    assertMayConfigureTargets(tenant, input.autoPublish.targets);
    await validateTargets(
      db,
      organisationId,
      input.autoPublish.targets,
      input.targetFormats?.map((f) => f.platform) ?? storedPlatforms(project.targetFormats),
    );
  }
  // Switching auto-publish on arms targets someone else may have stored: same capability.
  if (input.publishPolicy === 'AUTO_ON_APPROVAL' && !input.autoPublish)
    assertMayConfigureTargets(tenant, storedTargets(project.metadata));
  const metadata = projectMetadata(project.metadata);
  const hints = (metadata.briefHints as Record<string, unknown>) ?? {};
  const hintsChanged = Boolean(
    input.brief &&
    (input.brief.targetAudience !== undefined || input.brief.callToAction !== undefined),
  );
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
      ...(input.language !== undefined && { language: input.language }),
      ...((hintsChanged ||
        input.autoPublish ||
        input.autoResume !== undefined ||
        input.languages !== undefined ||
        input.approvalWorkflowId !== undefined) && {
        metadata: {
          ...metadata,
          ...(input.approvalWorkflowId !== undefined && {
            approvalWorkflowId: input.approvalWorkflowId ?? undefined,
          }),
          ...(input.languages !== undefined && { languages: input.languages }),
          ...(input.autoResume !== undefined && { autoResume: input.autoResume }),
          ...(hintsChanged && {
            briefHints: {
              ...hints,
              ...(input.brief?.targetAudience !== undefined && {
                targetAudience: input.brief.targetAudience,
              }),
              ...(input.brief?.callToAction !== undefined && {
                callToAction: input.brief.callToAction,
              }),
            },
          }),
          ...(input.autoPublish && { autoPublish: { targets: input.autoPublish.targets } }),
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

/**
 * Archive keeps the project and its posts, hides it from the default list and stops it being
 * generated or edited; unarchive puts it back in the state it had (metadata.archivedFrom). Delete
 * (archiveProject above, DELETE /projects/:id) is the one that removes it from every list.
 */
export async function setProjectArchived(
  db: Db,
  organisationId: string,
  id: string,
  archive: boolean,
) {
  const project = await findProject(db, organisationId, id);
  const metadata = projectMetadata(project.metadata);
  if (archive) {
    if (ACTIVE_PIPELINE_STATES.includes(project.state))
      throw new ConflictError('Cancel generation before archiving');
    if (project.state === 'ARCHIVED') return project;
  } else if (project.state !== 'ARCHIVED') {
    throw new ConflictError('Only an archived project can be restored');
  }
  const from = typeof metadata.archivedFrom === 'string' ? metadata.archivedFrom : 'DRAFT';
  const { archivedFrom: _drop, ...rest } = metadata;
  const updated = await db.videoProject.updateMany({
    where: { id, organisationId, state: project.state },
    data: archive
      ? {
          state: 'ARCHIVED',
          metadata: { ...metadata, archivedFrom: project.state } as Prisma.InputJsonValue,
        }
      : {
          state: (PROJECT_STATES.has(from) && from !== 'ARCHIVED'
            ? from
            : 'DRAFT') as VideoProjectState,
          metadata: rest as Prisma.InputJsonValue,
        },
  });
  if (updated.count === 0)
    throw new ConflictError('Project changed concurrently; reload and retry');
  return findProject(db, organisationId, id);
}

export async function duplicateProject(db: Db, tenant: TenantContext, id: string) {
  const source = await findProject(db, tenant.organisationId, id);
  // 22.1: a copy of a hook + demo video uses the same demo video (its own asset row on it).
  const hookDemo = readHookDemo(source.metadata);
  const demoUpload = hookDemo
    ? await resolveDemoUpload(db, {
        organisationId: source.organisationId,
        businessId: source.businessId,
        demoUploadId: hookDemo.demoUploadId,
      })
    : null;
  const data = duplicateData(source, tenant);
  if (!hookDemo || !demoUpload) return db.videoProject.create({ data });
  return db.$transaction(async (tx) => {
    const copy = await tx.videoProject.create({ data });
    const { assetId } = await attachDemoUpload(tx, demoUpload, copy.id);
    return tx.videoProject.update({
      where: { id: copy.id },
      data: {
        metadata: {
          ...projectMetadata(copy.metadata),
          hookDemo: { ...hookDemo, demoAssetId: assetId, writtenHookLine: null },
        } as Prisma.InputJsonValue,
      },
    });
  });
}

/** The copy's row (DRAFT, same brief, formats, look and format settings). */
function duplicateData(
  source: VideoProject,
  tenant: TenantContext,
): Prisma.VideoProjectUncheckedCreateInput {
  const hints = projectMetadata(source.metadata).briefHints;
  const stored = readCarousel(source.metadata);
  const carouselCopy = stored ? { ...stored, rewrites: 0 } : null;
  const ugcCopy = ugcStyleOf(source.metadata);
  const wallOfText = readWallOfText(source.metadata);
  return {
    organisationId: source.organisationId,
    businessId: source.businessId,
    createdByUserId: tenant.userId,
    // 17.9: an unnamed project's copy stays unnamed (no English words stored).
    name: isUntitledName(source.name) ? null : `${source.name} (copy)`.slice(0, 200),
    description: source.description,
    state: 'DRAFT',
    sourceType: source.sourceType,
    sourceRef: source.sourceRef,
    targetFormats: source.targetFormats as Prisma.InputJsonValue,
    brandKitId: source.brandKitId,
    templateId: source.templateId,
    costBudgetPence:
      source.costBudgetPence ??
      defaultProjectBudgetPence(
        budgetFormatsFromJson(source.targetFormats),
        source.sourceType,
        toPlanTier(tenant.organisation.planTier),
      ),
    reviewPolicy: source.reviewPolicy,
    publishPolicy: source.publishPolicy,
    language: source.language,
    metadata: {
      duplicatedFrom: source.id,
      ...(Array.isArray(projectMetadata(source.metadata).languages) && {
        languages: projectMetadata(source.metadata).languages as Prisma.InputJsonValue,
      }),
      ...(hints ? { briefHints: hints as Prisma.InputJsonValue } : {}),
      // 21.6: a carousel's copy keeps its posts, pictures and look (rewrite count starts again).
      ...(carouselCopy && { carousel: carouselCopy as unknown as Prisma.InputJsonValue }),
      // 21.4: a copy of a UGC video is a UGC video with the same actor (22.3: and creator).
      ...(ugcCopy && { ugc: ugcMetadata(ugcCopy) as unknown as Prisma.InputJsonValue }),
      // 22.2: a wall of text keeps its text block, background and length.
      ...(wallOfText && { wallOfText: { ...wallOfText, writtenText: null } }),
    },
  };
}

/** Start a new run: new runId (older jobs become no-ops), state QUEUED, enqueue plan-project. */
export async function generateProject(
  deps: { db: Db; queue: JobQueue },
  tenant: Pick<TenantContext, 'organisationId' | 'organisation'>,
  id: string,
  input: z.infer<typeof generateInput>,
  /** 20.9: month-plan items run as low-priority batch jobs (spec 11.2). */
  options: { batch?: boolean } = {},
) {
  const project = await findProject(deps.db, tenant.organisationId, id);
  if (!GENERATABLE_STATES.includes(project.state)) {
    throw new ConflictError(`Project is ${project.state}; cancel it or wait for it to finish`);
  }
  const runId = randomUUID();
  // 15.C4: a run may use a lower tier than the plan (422 above it) and preferred providers.
  const orgTier = toPlanTier(tenant.organisation.planTier);
  const planTier = effectiveTier(orgTier, input.qualityTier);
  const preferredProviders = validatePreferredProviders(input.preferredProviders, planTier);
  if (ugcStyleOf(project.metadata)) {
    // 21.4: a new brief is checked like the first one.
    assertNoRealPerson(input.rawInput);
  }
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
        ...generationStartMetadata(runId, Date.now()), // 15.D9: spec 17.1 generation SLO clock
        // Recorded so an operator re-drive (services/redrive.ts) can rebuild the job payload.
        planTier,
        renders: {},
        ...(input.confirmRestrictedTopics && { restrictedTopicsConfirmed: true }),
        directionOptions: undefined,
        // 20.18: answered by this run (confirmed, or a new brief that ideation checks again).
        pendingRestrictedTopics: undefined,
        // 20.18: per run, like preferredProviders (a later plain generate clears it).
        directionChosen: input.directionChosen === true ? true : undefined,
        // Per run: a new generate without preferences clears the previous run's.
        preferredProviders: preferredProviders ?? undefined,
        ...(input.qualityTier && { qualityTierOverride: { requested: planTier, plan: orgTier } }),
      } as Prisma.InputJsonValue,
    },
  });
  if (updated.count === 0)
    throw new ConflictError('Project changed concurrently; reload and retry');
  const job: ProjectJobData = {
    projectId: id,
    organisationId: tenant.organisationId,
    runId,
    planTier,
    ...(options.batch && { batch: true }),
  };
  try {
    await deps.queue.add('plan-project', job, { jobId: jobIds.planProject(job) });
  } catch (err) {
    // The queue is unreachable: no job will ever run, so the project must not stay QUEUED (the
    // user could neither generate again nor cancel it as failed). Put it back and report 502.
    await deps.db.videoProject.updateMany({
      where: { id, organisationId: tenant.organisationId, state: 'QUEUED' },
      // 20.18: the brief and metadata too, so a "choose a direction" project keeps its options.
      data: {
        state: project.state,
        errorReason: project.errorReason,
        description: project.description,
        metadata: (project.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
    throw new UpstreamServiceError('Generation could not be queued; try again shortly', {
      cause: err instanceof Error ? err.message : 'queue_unavailable',
    });
  }
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

/**
 * Human approval (spec 5.9). 15.D3: delegates to services/approval-workflows.ts, which runs the
 * multi-step workflow when one applies (the project stays READY_FOR_REVIEW until its last step)
 * and the original single-step approval otherwise. Returns the project, as before.
 */
export async function approveProject(
  db: Db,
  tenant: TenantContext,
  id: string,
  note: string | undefined,
  now: number,
) {
  return (await approveWithWorkflow(db, tenant, id, note, now)).project;
}

/** 15.D3: reject at any workflow step (services/approval-workflows.ts); same behaviour as before. */
export async function rejectProject(
  db: Db,
  tenant: TenantContext,
  id: string,
  note: string,
  now: number,
) {
  return rejectWithWorkflow(db, tenant, id, note, now);
}
