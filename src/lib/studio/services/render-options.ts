import type { Prisma, PrismaClient } from '@prisma/client';
import { NotFoundError, PlanTierError, ValidationError } from '../../errors';
import type { PlanTier } from '../providers/router';
import {
  FOUR_K_TIERS,
  parseRenderOptions,
  renderOptionsInput,
  type RenderOptions,
} from '../pipeline/render-presets';

// BACKLOG 15.B7 — PATCH /api/studio/projects/:id { renderOptions } (spec 5.8 per-format presets,
// spec 3.1 720p drafts and "4K for YouTube long-form (Plus tier+)"). Stored on
// video_projects.renderOptions and read at composition (render-presets.ts resolvePreset).
// A null field resets it to the platform default. DEVIATION from the plan's sample (422): a tier
// refusal uses the codebase's PlanTierError (403 plan_tier), like every other tier gate.

/** Split `renderOptions` off a PATCH body; `rest` goes to the ordinary project update. */
export function splitRenderOptions(body: unknown): {
  renderOptions: unknown;
  rest: Record<string, unknown>;
  hasRenderOptions: boolean;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return { renderOptions: undefined, rest: {}, hasRenderOptions: false };
  const { renderOptions, ...rest } = body as Record<string, unknown>;
  return { renderOptions, rest, hasRenderOptions: 'renderOptions' in body };
}

export function parseRenderOptionsInput(value: unknown): RenderOptions {
  const parsed = renderOptionsInput.safeParse(value);
  if (!parsed.success)
    throw new ValidationError('Request body failed validation', {
      issues: parsed.error.issues.slice(0, 20).map((i) => ({
        path: ['renderOptions', ...i.path].join('.'),
        message: i.message,
      })),
    });
  return parsed.data;
}

/** Merge the change into the stored options (null clears a field) after the tier check. */
export function mergeRenderOptions(
  stored: unknown,
  change: RenderOptions,
  planTier: PlanTier,
): RenderOptions {
  if (change.youtubeResolution === '4k' && !FOUR_K_TIERS.has(planTier))
    throw new PlanTierError('PLUS', '4K needs Plus', { planTier });
  const merged: Record<string, unknown> = { ...parseRenderOptions(stored) };
  for (const [key, value] of Object.entries(change)) {
    if (value === null) delete merged[key];
    else if (value !== undefined) merged[key] = value;
  }
  return merged as RenderOptions;
}

export async function setRenderOptions(
  db: Pick<PrismaClient, 'videoProject'>,
  input: { organisationId: string; projectId: string; planTier: PlanTier; change: RenderOptions },
): Promise<RenderOptions> {
  const project = await db.videoProject.findFirst({
    where: { id: input.projectId, organisationId: input.organisationId, deletedAt: null },
    select: { id: true, renderOptions: true },
  });
  if (!project) throw new NotFoundError('Project not found');
  const next = mergeRenderOptions(project.renderOptions, input.change, input.planTier);
  await db.videoProject.update({
    where: { id: project.id },
    data: { renderOptions: next as Prisma.InputJsonValue },
  });
  return next;
}
