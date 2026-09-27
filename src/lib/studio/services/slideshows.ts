import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, SlideshowSlide, VideoProjectState } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import type { TenantContext } from '../../tenant';
import { projectMetadata } from '../pipeline/project-state';
import { jobIds, type JobQueue } from '../queue/enqueue';
import {
  customSlides,
  expandTemplate,
  parseSlideContent,
  slideContent,
  slideInput,
  slideProblem,
  type SlideContent,
  type SlideDraft,
  type SlideshowInput,
} from '../slideshow/planner';
import { businessVideoAssets } from '../slideshow/resolve';
import { clampDuration, slidePlan, type SlideBlueprint } from '../slideshow/templates';
import { toPlanTier } from './catalog';

// BACKLOG 7.5 / 7.7 — slideshow templates, slide CRUD + reorder, auto-populate (A5.7 / A8.3).

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;

const SLIDE_EDITABLE_STATES: VideoProjectState[] = [
  'DRAFT',
  'FAILED',
  'REJECTED',
  'QUALITY_FAILED',
  'READY_FOR_REVIEW',
];
const MAX_SLIDES = 40;

// ---------------------------------------------------------------- templates

export const listTemplatesQuery = z.object({
  category: z.string().trim().min(1).max(60).optional(),
});

export function listTemplates(db: Db, organisationId: string, category?: string) {
  return db.slideshowTemplate.findMany({
    where: {
      OR: [{ organisationId: null }, { organisationId }],
      ...(category && { category }),
    },
    orderBy: [{ organisationId: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
  });
}

export async function findTemplate(db: Db, organisationId: string, id: string) {
  const template = await db.slideshowTemplate.findFirst({
    where: { id, OR: [{ organisationId: null }, { organisationId }] },
  });
  if (!template) throw new ValidationError('templateId is not a template available to you');
  const plan = slidePlan.safeParse(template.slidePlan);
  if (!plan.success) throw new ValidationError('Template has an invalid slide plan');
  return { ...template, plan: plan.data };
}

export const saveTemplateInput = z.object({
  projectId: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  category: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{1,60}$/, 'category must be lowercase letters, digits or _')
    .default('custom'),
});

/** "Save current slideshow as template" (A5.7): one blueprint per slide, no content copied. */
export async function saveTemplate(
  db: Db,
  tenant: TenantContext,
  input: z.infer<typeof saveTemplateInput>,
) {
  const project = await slideshowProject(db, tenant.organisationId, input.projectId);
  const slides = await db.slideshowSlide.findMany({
    where: { projectId: project.id },
    orderBy: { sortOrder: 'asc' },
  });
  if (slides.length === 0) throw new ValidationError('The slideshow has no slides to save');
  const plan: SlideBlueprint[] = slides.map((s) => {
    const content = parseSlideContent(s.metadata);
    return {
      role: content.role ?? 'body',
      slideType: s.slideType,
      durationSec: s.durationSec,
      ...(s.transitionIn && { transitionIn: s.transitionIn as SlideBlueprint['transitionIn'] }),
    };
  });
  return db.slideshowTemplate.create({
    data: {
      organisationId: tenant.organisationId,
      name: input.name,
      category: input.category,
      slidePlan: plan as unknown as Prisma.InputJsonValue,
      defaultDurationPerSlide:
        Math.round((slides.reduce((sum, s) => sum + s.durationSec, 0) / slides.length) * 10) / 10,
    },
  });
}

// ---------------------------------------------------------------- slides

async function slideshowProject(db: Db | Tx, organisationId: string, projectId: string) {
  const project = await db.videoProject.findFirst({
    where: { id: projectId, organisationId, deletedAt: null },
  });
  if (!project) throw new NotFoundError('Project not found');
  if (project.sourceType !== 'SLIDESHOW')
    throw new ConflictError('This project is not a slideshow');
  return project;
}

function assertEditable(state: VideoProjectState) {
  if (!SLIDE_EDITABLE_STATES.includes(state)) {
    throw new ConflictError(`Slides cannot be edited while the project is ${state}`);
  }
}

/** Every referenced image must be in this organisation's library for this business. */
async function assertAssets(
  db: Db | Tx,
  scope: { organisationId: string; businessId: string },
  drafts: Array<{
    imageAssetId: string | null;
    videoAssetId: string | null;
    metadata: SlideContent;
  }>,
) {
  const imageIds = new Set<string>();
  const videoIds = new Set<string>();
  for (const d of drafts) {
    if (d.imageAssetId) imageIds.add(d.imageAssetId);
    if (d.metadata.beforeImageId) imageIds.add(d.metadata.beforeImageId);
    if (d.metadata.afterImageId) imageIds.add(d.metadata.afterImageId);
    if (d.videoAssetId) videoIds.add(d.videoAssetId);
  }
  if (imageIds.size) {
    const found = await db.imageLibraryItem.count({
      where: { id: { in: [...imageIds] }, ...scope },
    });
    if (found !== imageIds.size)
      throw new ValidationError('An image id is not in this business’s image library');
  }
  if (videoIds.size) {
    const found = await businessVideoAssets(db, scope, [...videoIds]);
    if (found.length !== videoIds.size)
      throw new ValidationError('A video asset id is not a clip of this business');
  }
}

function toCreate(projectId: string, d: SlideDraft): Prisma.SlideshowSlideCreateManyInput {
  return {
    projectId,
    sortOrder: d.sortOrder,
    slideType: d.slideType,
    imageAssetId: d.imageAssetId,
    videoAssetId: d.videoAssetId,
    backgroundColor: d.backgroundColor,
    durationSec: d.durationSec,
    transitionIn: d.transitionIn,
    transitionOut: d.transitionOut,
    kenBurnsSpec: d.kenBurnsSpec ?? undefined,
    metadata: JSON.parse(JSON.stringify(d.metadata)) as Prisma.InputJsonValue,
  };
}

/** Slides for a new slideshow project, from a template or explicit slides (A8.5). */
export async function planSlideshowSlides(
  db: Db,
  scope: { organisationId: string; businessId: string },
  input: SlideshowInput,
): Promise<{ drafts: SlideDraft[]; templateId: string | null }> {
  const drafts = input.templateId
    ? expandTemplate(
        await findTemplate(db, scope.organisationId, input.templateId).then((t) => ({
          name: t.name,
          slidePlan: t.plan,
        })),
        input,
      )
    : customSlides(input.slides ?? []);
  if (drafts.length > MAX_SLIDES) throw new ValidationError(`At most ${MAX_SLIDES} slides`);
  await assertAssets(db, scope, drafts);
  return { drafts, templateId: input.templateId ?? null };
}

export async function insertSlides(tx: Tx, projectId: string, drafts: SlideDraft[]) {
  if (drafts.length)
    await tx.slideshowSlide.createMany({ data: drafts.map((d) => toCreate(projectId, d)) });
}

function present(slide: SlideshowSlide) {
  const content = parseSlideContent(slide.metadata);
  return { ...slide, content, problem: slideProblem({ ...slide, metadata: content }) };
}

export async function listSlides(db: Db, organisationId: string, projectId: string) {
  await slideshowProject(db, organisationId, projectId);
  const slides = await db.slideshowSlide.findMany({
    where: { projectId },
    orderBy: { sortOrder: 'asc' },
  });
  return slides.map(present);
}

export const addSlideInput = slideInput.extend({
  sortOrder: z.number().int().min(0).max(MAX_SLIDES).optional(),
});

export async function addSlide(
  db: Db,
  organisationId: string,
  projectId: string,
  input: z.infer<typeof addSlideInput>,
) {
  return db.$transaction(async (tx) => {
    const project = await slideshowProject(tx, organisationId, projectId);
    await lockProject(tx, project.id);
    assertEditable(project.state);
    const count = await tx.slideshowSlide.count({ where: { projectId } });
    if (count >= MAX_SLIDES) throw new ValidationError(`At most ${MAX_SLIDES} slides`);
    const [d] = customSlides([input]);
    const draft = { ...(d as SlideDraft), sortOrder: Math.min(input.sortOrder ?? count, count) };
    await assertAssets(tx, project, [draft]);
    await tx.slideshowSlide.updateMany({
      where: { projectId, sortOrder: { gte: draft.sortOrder } },
      data: { sortOrder: { increment: 1 } },
    });
    return present(await tx.slideshowSlide.create({ data: toCreate(projectId, draft) }));
  });
}

/**
 * Serialise slide mutations per project: sortOrder has no unique constraint, so concurrent
 * add/delete/reorder would otherwise both read the same order and write duplicates.
 */
async function lockProject(tx: Tx, projectId: string) {
  await tx.$queryRaw`SELECT id FROM studio.video_projects WHERE id = ${projectId} FOR UPDATE`;
}

async function slideWithProject(db: Db | Tx, organisationId: string, slideId: string) {
  const slide = await db.slideshowSlide.findUnique({ where: { id: slideId } });
  const project = slide
    ? await db.videoProject.findFirst({
        where: { id: slide.projectId, organisationId, deletedAt: null },
      })
    : null;
  if (!slide || !project) throw new NotFoundError('Slide not found');
  return { slide, project };
}

export const updateSlideInput = slideInput
  .partial()
  .extend({ content: slideContent.partial().optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export async function updateSlide(
  db: Db,
  organisationId: string,
  slideId: string,
  input: z.infer<typeof updateSlideInput>,
) {
  return db.$transaction(async (tx) => {
    const { slide: found, project } = await slideWithProject(tx, organisationId, slideId);
    await lockProject(tx, project.id);
    // Re-read after the lock: a concurrent mutation may have moved this slide.
    const slide = await tx.slideshowSlide.findUniqueOrThrow({ where: { id: found.id } });
    assertEditable(project.state);
    const slideType = input.slideType ?? slide.slideType;
    const content: SlideContent = {
      ...parseSlideContent(slide.metadata),
      ...input.content,
      // Editing text by hand resolves "pending" text.
      ...(input.content?.text !== undefined && { pendingText: undefined }),
    };
    const next = {
      imageAssetId: input.imageAssetId === undefined ? slide.imageAssetId : input.imageAssetId,
      videoAssetId: input.videoAssetId === undefined ? slide.videoAssetId : input.videoAssetId,
      metadata: content,
    };
    await assertAssets(tx, project, [next]);
    const updated = await tx.slideshowSlide.update({
      where: { id: slideId },
      data: {
        slideType,
        imageAssetId: next.imageAssetId,
        videoAssetId: next.videoAssetId,
        ...(input.backgroundColor !== undefined && { backgroundColor: input.backgroundColor }),
        durationSec: clampDuration(slideType, input.durationSec ?? slide.durationSec),
        ...(input.transitionIn !== undefined && { transitionIn: input.transitionIn }),
        ...(input.transitionOut !== undefined && { transitionOut: input.transitionOut }),
        ...(input.kenBurnsSpec !== undefined && {
          kenBurnsSpec: (input.kenBurnsSpec ?? undefined) as Prisma.InputJsonValue | undefined,
        }),
        metadata: JSON.parse(JSON.stringify(content)) as Prisma.InputJsonValue,
      },
    });
    return present(updated);
  });
}

export async function deleteSlide(db: Db, organisationId: string, slideId: string) {
  await db.$transaction(async (tx) => {
    const { slide: found, project } = await slideWithProject(tx, organisationId, slideId);
    await lockProject(tx, project.id);
    // Re-read after the lock: a concurrent mutation may have moved this slide.
    const slide = await tx.slideshowSlide.findUniqueOrThrow({ where: { id: found.id } });
    assertEditable(project.state);
    await tx.slideshowSlide.delete({ where: { id: slideId } });
    await tx.slideshowSlide.updateMany({
      where: { projectId: slide.projectId, sortOrder: { gt: slide.sortOrder } },
      data: { sortOrder: { decrement: 1 } },
    });
  });
}

export const reorderSlideInput = z.object({ newSortOrder: z.number().int().min(0) });

export async function reorderSlide(
  db: Db,
  organisationId: string,
  slideId: string,
  newSortOrder: number,
) {
  return db.$transaction(async (tx) => {
    const { slide: found, project } = await slideWithProject(tx, organisationId, slideId);
    await lockProject(tx, project.id);
    // Re-read after the lock: a concurrent mutation may have moved this slide.
    const slide = await tx.slideshowSlide.findUniqueOrThrow({ where: { id: found.id } });
    assertEditable(project.state);
    const count = await tx.slideshowSlide.count({ where: { projectId: slide.projectId } });
    const target = Math.min(newSortOrder, count - 1);
    if (target !== slide.sortOrder) {
      const movingDown = target > slide.sortOrder;
      await tx.slideshowSlide.updateMany({
        where: {
          projectId: slide.projectId,
          id: { not: slideId },
          sortOrder: movingDown
            ? { gt: slide.sortOrder, lte: target }
            : { gte: target, lt: slide.sortOrder },
        },
        data: { sortOrder: movingDown ? { decrement: 1 } : { increment: 1 } },
      });
      await tx.slideshowSlide.update({ where: { id: slideId }, data: { sortOrder: target } });
    }
    const slides = await tx.slideshowSlide.findMany({
      where: { projectId: slide.projectId },
      orderBy: { sortOrder: 'asc' },
    });
    return slides.map(present);
  });
}

// ---------------------------------------------------------------- auto-populate

/** POST /projects/:id/auto-populate: DRAFT → SCANNING, then the worker fills the gaps. */
export async function requestAutoPopulate(
  deps: { db: Db; queue: JobQueue },
  tenant: TenantContext,
  projectId: string,
) {
  const project = await slideshowProject(deps.db, tenant.organisationId, projectId);
  if (!SLIDE_EDITABLE_STATES.includes(project.state))
    throw new ConflictError(
      `Project is ${project.state}; auto-populate needs an editable slideshow`,
    );
  const populateId = randomUUID();
  const moved = await deps.db.videoProject.updateMany({
    where: { id: projectId, organisationId: tenant.organisationId, state: project.state },
    data: {
      state: 'SCANNING',
      metadata: {
        ...projectMetadata(project.metadata),
        populate: { id: populateId, returnTo: project.state },
      } as Prisma.InputJsonValue,
    },
  });
  if (moved.count === 0) throw new ConflictError('Project changed concurrently; reload and retry');
  const data = {
    projectId,
    organisationId: tenant.organisationId,
    runId: populateId,
    planTier: toPlanTier(tenant.organisation.planTier),
  };
  await deps.queue.add('populate-slideshow', data, { jobId: jobIds.populateSlideshow(data) });
  return { populateId };
}
