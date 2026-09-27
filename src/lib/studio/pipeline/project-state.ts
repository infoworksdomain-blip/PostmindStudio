import type { Prisma, PrismaClient, VideoProjectState } from '@prisma/client';

// Project lifecycle (spec 4.5 / 7.3). Transitions are compare-and-set on the current state, so
// concurrent workers can't move a project backwards or double-advance it.

export const ALLOWED_TRANSITIONS: Readonly<
  Record<VideoProjectState, readonly VideoProjectState[]>
> = {
  DRAFT: ['QUEUED', 'ARCHIVED'],
  QUEUED: ['PLANNING', 'SCANNING', 'FAILED', 'DRAFT'],
  SCANNING: ['PLANNING', 'FAILED'],
  PLANNING: ['ASSETS_QUEUED', 'FAILED', 'DRAFT'],
  ASSETS_QUEUED: ['ASSETS_GENERATING', 'RENDERING', 'FAILED'],
  ASSETS_GENERATING: ['RENDERING', 'FAILED'],
  RENDERING: ['QUALITY_CHECKING', 'FAILED'],
  QUALITY_CHECKING: ['READY_FOR_REVIEW', 'QUALITY_FAILED', 'FAILED'],
  QUALITY_FAILED: [
    'READY_FOR_REVIEW',
    'APPROVED',
    'QUEUED',
    'ASSETS_QUEUED',
    'REJECTED',
    'ARCHIVED',
  ],
  READY_FOR_REVIEW: ['APPROVED', 'REJECTED', 'QUEUED', 'ASSETS_QUEUED', 'ARCHIVED'],
  APPROVED: ['PUBLISHING', 'ARCHIVED'],
  PUBLISHING: ['PUBLISHED', 'PARTIALLY_PUBLISHED', 'FAILED'],
  PUBLISHED: ['ARCHIVED'],
  PARTIALLY_PUBLISHED: ['PUBLISHING', 'ARCHIVED'],
  REJECTED: ['QUEUED', 'ASSETS_QUEUED', 'ARCHIVED'],
  FAILED: ['QUEUED', 'ASSETS_QUEUED', 'ARCHIVED'],
  ARCHIVED: [],
};

export function canTransition(from: VideoProjectState, to: VideoProjectState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** States in which pipeline work for a run is still in progress. */
export const ACTIVE_PIPELINE_STATES: readonly VideoProjectState[] = [
  'QUEUED',
  'SCANNING',
  'PLANNING',
  'ASSETS_QUEUED',
  'ASSETS_GENERATING',
  'RENDERING',
  'QUALITY_CHECKING',
];

export interface ProjectRunMetadata {
  runId?: string;
  renderIds?: string[];
  [key: string]: unknown;
}

export function projectMetadata(value: Prisma.JsonValue | null): ProjectRunMetadata {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as ProjectRunMetadata)
    : {};
}

export function currentRunId(project: { metadata: Prisma.JsonValue | null }): string | undefined {
  return projectMetadata(project.metadata).runId;
}

type ProjectClient = Pick<PrismaClient, 'videoProject'>;

/**
 * Move a project from any state in `from` to `to`, only for the given run. Returns false (and
 * changes nothing) if the project was not in an allowed state or belongs to a newer run.
 */
export async function transitionProject(
  db: ProjectClient,
  input: {
    projectId: string;
    runId: string;
    from: readonly VideoProjectState[];
    to: VideoProjectState;
    data?: Omit<Prisma.VideoProjectUpdateManyMutationInput, 'state'>;
  },
): Promise<boolean> {
  const from = input.from.filter((state) => canTransition(state, input.to));
  if (from.length === 0) return false;
  const result = await db.videoProject.updateMany({
    where: {
      id: input.projectId,
      state: { in: [...from] },
      metadata: { path: ['runId'], equals: input.runId },
    },
    data: { ...input.data, state: input.to },
  });
  return result.count === 1;
}

/** Fail the project for this run from any active pipeline state. */
export async function failProject(
  db: ProjectClient,
  input: { projectId: string; runId: string; reason: string },
): Promise<boolean> {
  return transitionProject(db, {
    projectId: input.projectId,
    runId: input.runId,
    from: ACTIVE_PIPELINE_STATES,
    to: 'FAILED',
    data: { errorReason: input.reason.slice(0, 2_000) },
  });
}

type RawClient = Pick<PrismaClient, '$executeRaw'>;

/**
 * Merge top-level keys into project.metadata for one run, atomically in SQL (JSONB `||`), so
 * concurrent writers never lose each other's keys and a superseded run can never write.
 * Returns false when the project has moved on to another run.
 */
export async function mergeProjectMetadata(
  db: RawClient,
  input: { projectId: string; runId: string; patch: Record<string, unknown> },
): Promise<boolean> {
  const count = await db.$executeRaw`
    UPDATE "studio"."video_projects"
    SET "metadata" = COALESCE("metadata", '{}'::jsonb) || ${JSON.stringify(input.patch)}::jsonb,
        "updatedAt" = now()
    WHERE "id" = ${input.projectId} AND "metadata"->>'runId' = ${input.runId}`;
  return count === 1;
}

/** Record metadata.renders[scriptId] = renderId for one run, atomically. */
export async function recordRunRender(
  db: RawClient,
  input: { projectId: string; runId: string; scriptId: string; renderId: string },
): Promise<boolean> {
  const count = await db.$executeRaw`
    UPDATE "studio"."video_projects"
    SET "metadata" = jsonb_set(
          COALESCE("metadata", '{}'::jsonb),
          '{renders}',
          COALESCE("metadata"->'renders', '{}'::jsonb) || jsonb_build_object(${input.scriptId}::text, ${input.renderId}::text)
        ),
        "updatedAt" = now()
    WHERE "id" = ${input.projectId} AND "metadata"->>'runId' = ${input.runId}`;
  return count === 1;
}
