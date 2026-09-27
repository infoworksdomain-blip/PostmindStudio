import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import type { TenantContext } from '../../tenant';
import { projectMetadata } from '../pipeline/project-state';
import { jobIds, type JobQueue } from '../queue/enqueue';
import type { GenerateAssetJobData, ProjectJobData } from '../queue/queues';
import { toPlanTier } from './catalog';
import { getScript } from './shots';
import { assertScriptEditable, currentRenderIds, staleRenderIds } from './stale-renders';

// Phase 13.1 — script edit and regenerate (spec 8.3–8.4).
//   PATCH /scripts/:id: edit the voiceover blob and per-shot narration / on-screen text. Changed
//     narration regenerates that shot's voice only (the visual is kept), in a new run that then
//     re-composes; text-only edits start no run and mark the current renders stale.
//   POST /scripts/:id/regenerate: a new run from Layer 2 for this script, reusing the Layer 1
//     brief (video_briefs) and an optional instruction. Other scripts keep their renders.

type Deps = { db: PrismaClient; queue: JobQueue };

export const updateScriptInput = z
  .object({
    fullText: z.string().trim().min(1).max(20_000).optional(),
    shots: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(64),
            voiceoverText: z.string().trim().max(2_000).nullable().optional(),
            onScreenText: z.string().trim().max(300).nullable().optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict()
  .refine((v) => v.fullText !== undefined || (v.shots?.length ?? 0) > 0, {
    message: 'Nothing to update',
  });

export const regenerateScriptInput = z
  .object({ instruction: z.string().trim().min(1).max(1_000).optional() })
  .strict();

async function loadScript(db: PrismaClient, organisationId: string, id: string) {
  const script = await db.videoScript.findFirst({
    where: { id, project: { organisationId, deletedAt: null } },
    include: { project: true, shots: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!script) throw new NotFoundError('Script not found');
  return script;
}

const nullable = (value: string | null | undefined) =>
  value === undefined ? undefined : value || null;

export async function updateScript(
  deps: Deps,
  tenant: TenantContext,
  id: string,
  input: z.infer<typeof updateScriptInput>,
) {
  const script = await loadScript(deps.db, tenant.organisationId, id);
  const { project } = script;
  assertScriptEditable(project.state);
  const byId = new Map(script.shots.map((s) => [s.id, s]));
  const edits = input.shots ?? [];
  if (new Set(edits.map((e) => e.id)).size !== edits.length)
    throw new ValidationError('Each shot may appear once');
  for (const edit of edits)
    if (!byId.has(edit.id)) throw new ValidationError(`Shot ${edit.id} is not part of this script`);

  const voiceChanged = edits.filter((e) => {
    const next = nullable(e.voiceoverText);
    return next !== undefined && next !== byId.get(e.id)?.voiceoverText;
  });
  const planTier = toPlanTier(tenant.organisation.planTier);
  const runId = voiceChanged.length > 0 ? randomUUID() : null;
  const stale = [
    ...new Set([
      ...staleRenderIds(project.metadata),
      ...(await currentRenderIds(deps.db, project)),
    ]),
  ];

  await deps.db.$transaction(async (tx) => {
    const moved = await tx.videoProject.updateMany({
      where: { id: project.id, state: project.state, updatedAt: project.updatedAt },
      data: {
        ...(runId && { state: 'ASSETS_QUEUED', errorReason: null, completedAt: null }),
        metadata: {
          ...projectMetadata(project.metadata),
          staleRenders: stale,
          ...(runId && { runId, planTier, renders: {} }),
        } as Prisma.InputJsonValue,
      },
    });
    if (moved.count === 0)
      throw new ConflictError('Project changed concurrently; reload and retry');
    await tx.videoScript.update({
      where: { id },
      data: {
        ...(input.fullText !== undefined && { fullText: input.fullText }),
        version: { increment: 1 },
      },
    });
    for (const edit of edits) {
      const voice = voiceChanged.some((v) => v.id === edit.id);
      await tx.videoShot.update({
        where: { id: edit.id },
        data: {
          ...(edit.voiceoverText !== undefined && { voiceoverText: nullable(edit.voiceoverText) }),
          ...(edit.onScreenText !== undefined && { onScreenText: nullable(edit.onScreenText) }),
          // Voice-only regeneration: keep the visual, drop the narration asset.
          ...(voice && { voiceAssetId: null, state: 'QUEUED', errorReason: null }),
        },
      });
    }
  });

  if (runId) {
    for (const shot of voiceChanged) {
      const job: GenerateAssetJobData = {
        projectId: project.id,
        organisationId: tenant.organisationId,
        runId,
        planTier,
        shotId: shot.id,
      };
      await deps.queue.add('generate-asset', job, { jobId: jobIds.generateAsset(job) });
    }
  }
  return {
    script: await getScript(deps.db, tenant.organisationId, id),
    staleRenders: stale,
    runId,
    voiceRegenerated: voiceChanged.map((s) => s.id),
  };
}

/** metadata.scriptRegenerate for the current run (read by plan-project). */
export interface ScriptRegeneration {
  runId: string;
  scriptId: string;
  instruction: string | null;
}

export function scriptRegeneration(
  metadata: Prisma.JsonValue | null,
  runId: string,
): ScriptRegeneration | null {
  const value = projectMetadata(metadata).scriptRegenerate as Partial<ScriptRegeneration> | null;
  if (!value || value.runId !== runId || typeof value.scriptId !== 'string') return null;
  return {
    runId,
    scriptId: value.scriptId,
    instruction: typeof value.instruction === 'string' ? value.instruction : null,
  };
}

export async function regenerateScript(
  deps: Deps,
  tenant: TenantContext,
  id: string,
  input: z.infer<typeof regenerateScriptInput>,
) {
  const script = await loadScript(deps.db, tenant.organisationId, id);
  const { project } = script;
  assertScriptEditable(project.state);
  if (project.sourceType === 'SLIDESHOW' || project.sourceType === 'UPLOAD')
    throw new ConflictError(`A ${project.sourceType} project has no generated script to rewrite`);
  const brief = await deps.db.videoBrief.findUnique({
    where: { projectId: project.id },
    select: { id: true },
  });
  if (!brief)
    throw new ConflictError('The project has no Layer 1 brief to reuse; generate it instead');

  const runId = randomUUID();
  const planTier = toPlanTier(tenant.organisation.planTier);
  const metadata = projectMetadata(project.metadata);
  const previous = (metadata.renders as Record<string, string> | undefined) ?? {};
  // Other formats keep their renders: composition only renders scripts missing from the map.
  const keptRenders = Object.fromEntries(Object.entries(previous).filter(([k]) => k !== id));
  const stale = [
    ...new Set([...staleRenderIds(project.metadata), ...(previous[id] ? [previous[id]] : [])]),
  ];
  const moved = await deps.db.videoProject.updateMany({
    where: { id: project.id, state: project.state, updatedAt: project.updatedAt },
    data: {
      state: 'QUEUED',
      errorReason: null,
      completedAt: null,
      metadata: {
        ...metadata,
        runId,
        planTier,
        renders: keptRenders,
        staleRenders: stale,
        scriptRegenerate: { runId, scriptId: id, instruction: input.instruction ?? null },
      } as Prisma.InputJsonValue,
    },
  });
  if (moved.count === 0) throw new ConflictError('Project changed concurrently; reload and retry');
  const job: ProjectJobData = {
    projectId: project.id,
    organisationId: tenant.organisationId,
    runId,
    planTier,
  };
  await deps.queue.add('plan-project', job, { jobId: jobIds.planProject(job) });
  return { project: { id: project.id, state: 'QUEUED' as const }, runId, staleRenders: stale };
}
