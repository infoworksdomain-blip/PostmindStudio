import type { Prisma, PrismaClient, VideoProject, VideoProjectState } from '@prisma/client';
import { ConflictError } from '../../errors';
import { projectMetadata } from '../pipeline/project-state';

// Phase 13.1 / 13.2 — edits that change what a render shows (script text, a swapped or deleted
// shot) do not re-render by themselves. The project's current renders are recorded as stale in
// `metadata.staleRenders` until the next composition replaces them (compose-video clears the
// list), so the review screen can say "out of date — re-render".

type Tx = Prisma.TransactionClient;

/** Finished projects whose script and shots may be edited (same states as shot regenerate). */
export const SCRIPT_EDITABLE_STATES: VideoProjectState[] = [
  'READY_FOR_REVIEW',
  'QUALITY_FAILED',
  'FAILED',
  'REJECTED',
];

export function assertScriptEditable(state: VideoProjectState): void {
  if (!SCRIPT_EDITABLE_STATES.includes(state)) {
    throw new ConflictError(
      `The script can be edited once the project has finished (project is ${state})`,
    );
  }
}

/** Render ids of the project's current run (metadata.renders), else every render it has. */
export async function currentRenderIds(
  db: Pick<PrismaClient, 'videoRender'> | Tx,
  project: Pick<VideoProject, 'id' | 'metadata'>,
): Promise<string[]> {
  const map = projectMetadata(project.metadata).renders;
  const fromRun =
    map && typeof map === 'object' && !Array.isArray(map)
      ? Object.values(map as Record<string, unknown>).filter(
          (id): id is string => typeof id === 'string',
        )
      : [];
  if (fromRun.length > 0) return fromRun;
  const rows = await db.videoRender.findMany({
    where: { projectId: project.id },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export function staleRenderIds(metadata: Prisma.JsonValue | null): string[] {
  const list = projectMetadata(metadata).staleRenders;
  return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * Mark the project's current renders stale, compare-and-set on updatedAt so a concurrent run
 * start is not overwritten. Returns the stale render ids.
 */
export async function markRendersStale(
  tx: Tx,
  project: Pick<VideoProject, 'id' | 'metadata' | 'state' | 'updatedAt'>,
): Promise<string[]> {
  const ids = [
    ...new Set([...staleRenderIds(project.metadata), ...(await currentRenderIds(tx, project))]),
  ];
  const moved = await tx.videoProject.updateMany({
    where: { id: project.id, state: project.state, updatedAt: project.updatedAt },
    data: {
      metadata: {
        ...projectMetadata(project.metadata),
        staleRenders: ids,
      } as Prisma.InputJsonValue,
    },
  });
  if (moved.count === 0) throw new ConflictError('Project changed concurrently; reload and retry');
  return ids;
}
