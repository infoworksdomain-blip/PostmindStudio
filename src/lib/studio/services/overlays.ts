import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, TextOverlay, VideoProjectState } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import type { TenantContext } from '../../tenant';
import {
  overlayStyle,
  overlayStyleFromRow,
  overlayText,
  presetParameters,
  resolveStyle,
  type OverlayStyle,
  type PresetParameters,
} from '../overlays/params';
import { PRESET_GROUPS } from '../overlays/presets';
import { projectMetadata } from '../pipeline/project-state';
import { jobIds, type JobQueue } from '../queue/enqueue';
import { toPlanTier } from './catalog';
import { assertTierGate } from './tier-gates';

// BACKLOG 8.6 / Addendum A4.8 — overlay presets and overlays. Overlays belong to a shot (or to a
// render for whole-video overlays); ownership is always proven through the project's
// organisation. Edits never re-render by themselves: POST /renders/:id/rerender applies them.

type Db = PrismaClient;

const OVERLAY_EDITABLE_STATES: VideoProjectState[] = [
  'DRAFT',
  'FAILED',
  'REJECTED',
  'QUALITY_FAILED',
  'READY_FOR_REVIEW',
];
export const MAX_OVERLAYS_PER_SHOT = 12;
/** Whole-video overlays (watermarks, bugs) across a project's renders. */
export const MAX_WHOLE_VIDEO_OVERLAYS = 6;

// ---------------------------------------------------------------- presets

export const listPresetsQuery = z.object({
  group: z.enum(PRESET_GROUPS).optional(),
  businessId: z.string().trim().min(1).max(128).optional(),
});

export function listPresets(
  db: Db,
  organisationId: string,
  query: z.infer<typeof listPresetsQuery>,
) {
  return db.overlayPreset.findMany({
    where: {
      ...(query.group && { group: query.group }),
      OR: [
        { scope: 'BUILT_IN' },
        { scope: 'ORG', organisationId },
        ...(query.businessId
          ? [{ scope: 'BUSINESS' as const, organisationId, businessId: query.businessId }]
          : []),
      ],
    },
    orderBy: [{ scope: 'asc' }, { group: 'asc' }, { name: 'asc' }],
  });
}

export const createPresetInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    group: z.enum(PRESET_GROUPS),
    scope: z.enum(['org', 'business']),
    businessId: z.string().trim().min(1).max(128).optional(),
    parameters: presetParameters,
    brandSubstitution: z.boolean().default(true),
  })
  .refine((v) => v.scope !== 'business' || v.businessId, {
    message: 'businessId is required for business-scoped presets',
  });

export function createPreset(
  db: Db,
  tenant: TenantContext,
  input: z.infer<typeof createPresetInput>,
) {
  // 15.D2 / A10.3 "Save custom overlay presets": Standard and above (Basic: presets only).
  assertTierGate(tenant, 'overlays.custom_presets');
  return db.overlayPreset.create({
    data: {
      scope: input.scope === 'org' ? 'ORG' : 'BUSINESS',
      organisationId: tenant.organisationId,
      businessId: input.scope === 'business' ? (input.businessId ?? null) : null,
      name: input.name,
      group: input.group,
      parameters: input.parameters as Prisma.InputJsonValue,
      brandSubstitution: input.brandSubstitution,
    },
  });
}

async function ownPreset(db: Db, organisationId: string, id: string) {
  const preset = await db.overlayPreset.findFirst({
    where: { id, OR: [{ scope: 'BUILT_IN' }, { organisationId }] },
  });
  if (!preset) throw new NotFoundError('Preset not found');
  if (preset.scope === 'BUILT_IN') throw new ConflictError('Built-in presets cannot be changed');
  return preset;
}

export const updatePresetInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    group: z.enum(PRESET_GROUPS),
    parameters: presetParameters,
    brandSubstitution: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export async function updatePreset(
  db: Db,
  organisationId: string,
  id: string,
  input: z.infer<typeof updatePresetInput>,
) {
  await ownPreset(db, organisationId, id);
  return db.overlayPreset.update({
    where: { id },
    data: {
      ...input,
      ...(input.parameters && { parameters: input.parameters as Prisma.InputJsonValue }),
    },
  });
}

export async function deletePreset(db: Db, organisationId: string, id: string) {
  await ownPreset(db, organisationId, id);
  await db.overlayPreset.delete({ where: { id } });
}

/** A preset usable by this organisation (built-in, org, or this business's), with parameters. */
async function usablePreset(
  db: Db,
  scope: { organisationId: string; businessId: string },
  id: string,
): Promise<{ id: string; parameters: PresetParameters }> {
  const preset = await db.overlayPreset.findFirst({
    where: {
      id,
      OR: [
        { scope: 'BUILT_IN' },
        { scope: 'ORG', organisationId: scope.organisationId },
        { scope: 'BUSINESS', organisationId: scope.organisationId, businessId: scope.businessId },
      ],
    },
  });
  if (!preset) throw new ValidationError('presetId is not a preset available to this project');
  const parsed = presetParameters.safeParse(preset.parameters);
  return { id: preset.id, parameters: parsed.success ? parsed.data : {} };
}

// ---------------------------------------------------------------- overlays

async function shotWithProject(db: Db, organisationId: string, shotId: string) {
  const shot = await db.videoShot.findFirst({
    where: { id: shotId, script: { project: { organisationId, deletedAt: null } } },
    include: { script: { include: { project: true } } },
  });
  if (!shot) throw new NotFoundError('Shot not found');
  return { shot, project: shot.script.project };
}

async function overlayWithProject(db: Db, organisationId: string, id: string) {
  const overlay = await db.textOverlay.findUnique({ where: { id } });
  if (overlay?.shotId) {
    const { shot, project } = await shotWithProject(db, organisationId, overlay.shotId).catch(
      () => ({ shot: null, project: null }),
    );
    if (shot && project) return { overlay, project, maxEndSec: shot.durationSec };
  } else if (overlay?.slideId) {
    const found = await slideWithProject(db, organisationId, overlay.slideId).catch(() => null);
    if (found) return { overlay, project: found.project, maxEndSec: found.slide.durationSec };
  } else if (overlay?.renderId) {
    const render = await db.videoRender.findFirst({
      where: { id: overlay.renderId, project: { organisationId, deletedAt: null } },
      include: { project: true },
    });
    if (render) return { overlay, project: render.project, maxEndSec: render.durationSec };
  }
  throw new NotFoundError('Overlay not found');
}

function assertEditable(state: VideoProjectState) {
  if (!OVERLAY_EDITABLE_STATES.includes(state))
    throw new ConflictError(`Overlays cannot be edited while the project is ${state}`);
}

function assertTiming(startAtSec: number, endAtSec: number, maxEndSec: number) {
  if (endAtSec <= startAtSec) throw new ValidationError('endAtSec must be after startAtSec');
  if (endAtSec > maxEndSec + 1e-6)
    throw new ValidationError(`endAtSec must be within the ${maxEndSec}s it is attached to`);
}

function styleColumns(style: OverlayStyle) {
  return { ...style, effect: (style.effect ?? undefined) as Prisma.InputJsonValue | undefined };
}

export const createOverlayInput = overlayText.extend({
  startAtSec: z.number().min(0).max(3_600),
  endAtSec: z.number().min(0).max(3_600),
  presetId: z.string().trim().min(1).max(64).optional(),
  /** Overrides on top of the preset (or the default style). */
  style: overlayStyle.partial().optional(),
  sortOrder: z.number().int().min(0).max(100).optional(),
});
type CreateOverlay = z.infer<typeof createOverlayInput>;

async function buildOverlayData(
  db: Db,
  scope: { organisationId: string; businessId: string },
  input: CreateOverlay,
) {
  const preset = input.presetId ? await usablePreset(db, scope, input.presetId) : null;
  const style = resolveStyle(preset?.parameters, input.style);
  const checked = overlayStyle.safeParse(style);
  if (!checked.success) throw new ValidationError('Overlay style is invalid');
  return {
    presetId: preset?.id ?? null,
    text: input.text,
    ...(input.lang && { lang: input.lang }),
    startAtSec: input.startAtSec,
    endAtSec: input.endAtSec,
    sortOrder: input.sortOrder ?? 0,
    ...styleColumns(checked.data),
  };
}

export async function listShotOverlays(db: Db, organisationId: string, shotId: string) {
  await shotWithProject(db, organisationId, shotId);
  return db.textOverlay.findMany({
    where: { shotId },
    orderBy: [{ sortOrder: 'asc' }, { startAtSec: 'asc' }],
  });
}

export async function createShotOverlay(
  db: Db,
  organisationId: string,
  shotId: string,
  input: CreateOverlay,
): Promise<TextOverlay> {
  const { shot, project } = await shotWithProject(db, organisationId, shotId);
  assertEditable(project.state);
  assertTiming(input.startAtSec, input.endAtSec, shot.durationSec);
  const count = await db.textOverlay.count({ where: { shotId } });
  if (count >= MAX_OVERLAYS_PER_SHOT)
    throw new ValidationError(`At most ${MAX_OVERLAYS_PER_SHOT} overlays per shot`);
  const data = await buildOverlayData(db, project, input);
  return db.textOverlay.create({ data: { ...data, shotId } });
}

export const updateOverlayInput = overlayText
  .partial()
  .extend({
    startAtSec: z.number().min(0).max(3_600).optional(),
    endAtSec: z.number().min(0).max(3_600).optional(),
    sortOrder: z.number().int().min(0).max(100).optional(),
    style: overlayStyle.partial().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export async function updateOverlay(
  db: Db,
  organisationId: string,
  id: string,
  input: z.infer<typeof updateOverlayInput>,
) {
  const { overlay, project, maxEndSec } = await overlayWithProject(db, organisationId, id);
  assertEditable(project.state);
  const startAtSec = input.startAtSec ?? overlay.startAtSec;
  const endAtSec = input.endAtSec ?? overlay.endAtSec;
  assertTiming(startAtSec, endAtSec, maxEndSec);
  let style: Record<string, unknown> = {};
  if (input.style) {
    const current = overlayStyleFromRow
      .partial()
      .safeParse({ ...overlay, effect: overlay.effect ?? null });
    const merged = overlayStyle.safeParse(
      resolveStyle(current.success ? current.data : {}, input.style),
    );
    if (!merged.success) throw new ValidationError('Overlay style is invalid');
    style = styleColumns(merged.data);
  }
  return db.textOverlay.update({
    where: { id },
    data: {
      ...(input.text !== undefined && { text: input.text }),
      ...(input.lang !== undefined && { lang: input.lang }),
      ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
      startAtSec,
      endAtSec,
      ...style,
    },
  });
}

export async function deleteOverlay(db: Db, organisationId: string, id: string) {
  const { project } = await overlayWithProject(db, organisationId, id);
  assertEditable(project.state);
  await db.textOverlay.delete({ where: { id } });
}

// ---------------------------------------------------------------- whole-video (13.3)

/**
 * GET /renders/:id/overlays: the whole-video overlays composition applies to this render's
 * platform — those attached to any render of the project with the same platform
 * (compose-video.ts), oldest first.
 */
export async function listRenderOverlays(db: Db, organisationId: string, renderId: string) {
  const render = await db.videoRender.findFirst({
    where: { id: renderId, project: { organisationId, deletedAt: null } },
    select: { projectId: true, targetPlatform: true },
  });
  if (!render) throw new NotFoundError('Render not found');
  const siblings = await db.videoRender.findMany({
    where: { projectId: render.projectId, targetPlatform: render.targetPlatform },
    select: { id: true },
  });
  return db.textOverlay.findMany({
    where: { renderId: { in: siblings.map((r) => r.id) } },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

// ---------------------------------------------------------------- per-slide (13.4)

export const MAX_OVERLAYS_PER_SLIDE = 12;

async function slideWithProject(db: Db, organisationId: string, slideId: string) {
  const slide = await db.slideshowSlide.findUnique({ where: { id: slideId } });
  const project = slide
    ? await db.videoProject.findFirst({
        where: { id: slide.projectId, organisationId, deletedAt: null },
      })
    : null;
  if (!slide || !project) throw new NotFoundError('Slide not found');
  return { slide, project };
}

export async function listSlideOverlays(db: Db, organisationId: string, slideId: string) {
  await slideWithProject(db, organisationId, slideId);
  return db.textOverlay.findMany({
    where: { slideId },
    orderBy: [{ sortOrder: 'asc' }, { startAtSec: 'asc' }],
  });
}

/** Slide overlays default to the whole slide when no timing is given. */
export const createSlideOverlayInput = createOverlayInput.extend({
  startAtSec: z.number().min(0).max(3_600).optional(),
  endAtSec: z.number().min(0).max(3_600).optional(),
});

export async function createSlideOverlay(
  db: Db,
  organisationId: string,
  slideId: string,
  input: z.infer<typeof createSlideOverlayInput>,
): Promise<TextOverlay> {
  const { slide, project } = await slideWithProject(db, organisationId, slideId);
  assertEditable(project.state);
  const startAtSec = input.startAtSec ?? 0;
  const endAtSec = input.endAtSec ?? slide.durationSec;
  assertTiming(startAtSec, endAtSec, slide.durationSec);
  const count = await db.textOverlay.count({ where: { slideId } });
  if (count >= MAX_OVERLAYS_PER_SLIDE)
    throw new ValidationError(`At most ${MAX_OVERLAYS_PER_SLIDE} overlays per slide`);
  const data = await buildOverlayData(db, project, { ...input, startAtSec, endAtSec });
  return db.textOverlay.create({ data: { ...data, slideId } });
}

export const bulkOverlayInput = z.object({
  overlay: createOverlayInput,
  /** Apply to these shots (timing relative to each shot); omit for one whole-video overlay. */
  applyToShotIds: z.array(z.string().trim().min(1).max(64)).min(1).max(100).optional(),
});

/** POST /renders/:id/overlays/bulk (A4.8): e.g. a persistent watermark. */
export async function bulkOverlays(
  db: Db,
  organisationId: string,
  renderId: string,
  input: z.infer<typeof bulkOverlayInput>,
): Promise<TextOverlay[]> {
  const render = await db.videoRender.findFirst({
    where: { id: renderId, project: { organisationId, deletedAt: null } },
    include: { project: true },
  });
  if (!render) throw new NotFoundError('Render not found');
  assertEditable(render.project.state);
  const data = await buildOverlayData(db, render.project, input.overlay);
  if (!input.applyToShotIds) {
    assertTiming(data.startAtSec, data.endAtSec, render.durationSec);
    const renders = await db.videoRender.findMany({
      where: { projectId: render.projectId },
      select: { id: true },
    });
    const existing = await db.textOverlay.count({
      where: { renderId: { in: renders.map((r) => r.id) } },
    });
    if (existing >= MAX_WHOLE_VIDEO_OVERLAYS)
      throw new ValidationError(`At most ${MAX_WHOLE_VIDEO_OVERLAYS} whole-video overlays`);
    return [await db.textOverlay.create({ data: { ...data, renderId } })];
  }
  const shots = await db.videoShot.findMany({
    where: { id: { in: input.applyToShotIds }, scriptId: render.scriptId },
  });
  if (shots.length !== new Set(input.applyToShotIds).size)
    throw new ValidationError('applyToShotIds must be shots of this render');
  for (const shot of shots) assertTiming(data.startAtSec, data.endAtSec, shot.durationSec);
  // Same per-shot cap as POST /shots/:id/overlays.
  const counts = await db.textOverlay.groupBy({
    by: ['shotId'],
    where: { shotId: { in: shots.map((s) => s.id) } },
    _count: { _all: true },
  });
  if (counts.some((c) => c._count._all >= MAX_OVERLAYS_PER_SHOT))
    throw new ValidationError(`At most ${MAX_OVERLAYS_PER_SHOT} overlays per shot`);
  return db.$transaction(
    shots.map((shot) => db.textOverlay.create({ data: { ...data, shotId: shot.id } })),
  );
}

// ---------------------------------------------------------------- re-render

const RERENDER_STATES: VideoProjectState[] = ['READY_FOR_REVIEW', 'QUALITY_FAILED', 'REJECTED'];

/**
 * POST /renders/:id/rerender: re-compose the project with its current shots, assets and
 * overlays (no Layer 1–4 spend). A new run id supersedes any older in-flight work.
 */
export async function rerenderProject(
  deps: { db: Db; queue: JobQueue },
  tenant: TenantContext,
  renderId: string,
) {
  const render = await deps.db.videoRender.findFirst({
    where: { id: renderId, project: { organisationId: tenant.organisationId, deletedAt: null } },
    include: { project: true },
  });
  if (!render) throw new NotFoundError('Render not found');
  const project = render.project;
  if (!RERENDER_STATES.includes(project.state))
    throw new ConflictError(`Project is ${project.state}; re-render needs a reviewed project`);
  const runId = randomUUID();
  const moved = await deps.db.videoProject.updateMany({
    where: { id: project.id, state: project.state, updatedAt: project.updatedAt },
    data: {
      state: 'ASSETS_QUEUED',
      errorReason: null,
      completedAt: null,
      metadata: {
        ...projectMetadata(project.metadata),
        runId,
        planTier: toPlanTier(tenant.organisation.planTier),
        renders: {},
        rerenderOf: render.id,
      } as Prisma.InputJsonValue,
    },
  });
  if (moved.count === 0) throw new ConflictError('Project changed concurrently; reload and retry');
  const data = {
    projectId: project.id,
    organisationId: tenant.organisationId,
    runId,
    planTier: toPlanTier(tenant.organisation.planTier),
  };
  await deps.queue.add('compose-video', data, { jobId: jobIds.composeVideo(data) });
  return { projectId: project.id, runId };
}
