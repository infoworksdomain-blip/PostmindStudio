import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, VideoProjectState } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, NotFoundError } from '../../errors';
import type { TenantContext } from '../../tenant';
import { projectMetadata } from '../pipeline/project-state';
import { jobIds, type JobQueue } from '../queue/enqueue';
import type { GenerateAssetJobData } from '../queue/queues';
import { toPlanTier } from './catalog';

// Scripts and shots (spec 8.3, BACKLOG 4.9). Editing or regenerating a shot starts a new run in
// which only that shot is regenerated; untouched shots keep their assets, and composition and the
// quality gate re-run over the whole script.

const REGENERATABLE_STATES: VideoProjectState[] = [
  'READY_FOR_REVIEW',
  'QUALITY_FAILED',
  'FAILED',
  'REJECTED',
];

export const updateShotInput = z
  .object({
    voiceoverText: z.string().trim().max(2_000).nullable().optional(),
    onScreenText: z.string().trim().max(300).nullable().optional(),
  })
  .refine((v) => v.voiceoverText !== undefined || v.onScreenText !== undefined, {
    message: 'Nothing to update',
  });

export const regenerateShotInput = z.object({
  /** Replace the generation prompt (scene description). */
  prompt: z.string().trim().min(1).max(2_000).optional(),
  /** Prefer this provider if it can serve the shot (router still applies health/budget checks). */
  providerId: z.string().trim().min(1).max(64).optional(),
});

async function loadShot(db: PrismaClient, organisationId: string, id: string) {
  const shot = await db.videoShot.findFirst({
    where: { id, script: { project: { organisationId, deletedAt: null } } },
    include: { script: { select: { id: true, projectId: true } } },
  });
  if (!shot) throw new NotFoundError('Shot not found');
  return shot;
}

export async function listScripts(db: PrismaClient, organisationId: string, projectId: string) {
  const project = await db.videoProject.findFirst({
    where: { id: projectId, organisationId, deletedAt: null },
    select: { id: true },
  });
  if (!project) throw new NotFoundError('Project not found');
  return db.videoScript.findMany({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
    include: { shots: { orderBy: { sortOrder: 'asc' } } },
  });
}

export async function getScript(db: PrismaClient, organisationId: string, id: string) {
  const script = await db.videoScript.findFirst({
    where: { id, project: { organisationId, deletedAt: null } },
    include: { shots: { orderBy: { sortOrder: 'asc' }, include: { overlays: true } } },
  });
  if (!script) throw new NotFoundError('Script not found');
  return script;
}

export async function getShot(db: PrismaClient, organisationId: string, id: string) {
  const shot = await loadShot(db, organisationId, id);
  const assetIds = [shot.assetId, shot.voiceAssetId].filter((a): a is string => Boolean(a));
  const assets = await db.videoAsset.findMany({ where: { id: { in: assetIds }, organisationId } });
  return { ...shot, assets };
}

/** Put the project into a fresh run that regenerates exactly one shot. */
async function startShotRun(
  deps: { db: PrismaClient; queue: JobQueue },
  tenant: TenantContext,
  shotId: string,
  projectId: string,
  shotUpdate: Prisma.VideoShotUpdateInput,
) {
  const project = await deps.db.videoProject.findFirstOrThrow({
    where: { id: projectId, organisationId: tenant.organisationId },
  });
  if (!REGENERATABLE_STATES.includes(project.state)) {
    throw new ConflictError(
      `Shots can be regenerated once the project has finished (project is ${project.state})`,
    );
  }
  const runId = randomUUID();
  await deps.db.$transaction(async (tx) => {
    const moved = await tx.videoProject.updateMany({
      where: {
        id: projectId,
        organisationId: tenant.organisationId,
        state: project.state,
        updatedAt: project.updatedAt,
      },
      data: {
        state: 'ASSETS_QUEUED',
        errorReason: null,
        completedAt: null,
        metadata: {
          ...projectMetadata(project.metadata),
          runId,
          planTier: toPlanTier(tenant.organisation.planTier),
          renders: {},
        } as Prisma.InputJsonValue,
      },
    });
    if (moved.count === 0)
      throw new ConflictError('Project changed concurrently; reload and retry');
    await tx.videoShot.update({
      where: { id: shotId },
      data: { ...shotUpdate, state: 'QUEUED', errorReason: null },
    });
  });
  const job: GenerateAssetJobData = {
    projectId,
    organisationId: tenant.organisationId,
    runId,
    planTier: toPlanTier(tenant.organisation.planTier),
    shotId,
  };
  await deps.queue.add('generate-asset', job, { jobId: jobIds.generateAsset(job) });
  return runId;
}

/** Edit narration / caption text (spec 8.3: "Triggers voice regeneration only"). */
export async function updateShot(
  deps: { db: PrismaClient; queue: JobQueue },
  tenant: TenantContext,
  id: string,
  input: z.infer<typeof updateShotInput>,
) {
  const shot = await loadShot(deps.db, tenant.organisationId, id);
  const voiceChanged =
    input.voiceoverText !== undefined && input.voiceoverText !== shot.voiceoverText;
  const runId = await startShotRun(deps, tenant, id, shot.script.projectId, {
    ...(input.voiceoverText !== undefined && { voiceoverText: input.voiceoverText || null }),
    ...(input.onScreenText !== undefined && { onScreenText: input.onScreenText || null }),
    // Keep the visual; drop the narration only when its text changed.
    ...(voiceChanged && { voiceAssetId: null }),
  });
  return { runId, voiceRegenerated: voiceChanged };
}

export async function regenerateShot(
  deps: { db: PrismaClient; queue: JobQueue },
  tenant: TenantContext,
  id: string,
  input: z.infer<typeof regenerateShotInput>,
) {
  const shot = await loadShot(deps.db, tenant.organisationId, id);
  // Uploaded / swapped-in clips have no generator to re-run (13.2 / 13.5).
  if (shot.visualTreatment === 'USER_UPLOAD')
    throw new ConflictError('This shot shows an uploaded clip; swap it instead of regenerating');
  const routing = (shot.providerRouting as Record<string, unknown> | null) ?? {};
  const runId = await startShotRun(deps, tenant, id, shot.script.projectId, {
    assetId: null,
    ...(input.prompt && { sceneDescription: input.prompt }),
    providerRouting: {
      ...routing,
      preferredProviderId: input.providerId ?? null,
    } as Prisma.InputJsonValue,
  });
  return { runId };
}
