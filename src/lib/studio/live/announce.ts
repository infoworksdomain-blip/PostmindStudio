import type { PrismaClient } from '@prisma/client';
import { logger as rootLogger } from '../../logger';
import type { ProjectEventBus } from './events';

// BACKLOG 24.2 — the one call that announces a project status change. transitionProject (every
// pipeline stage move and failure) and the publish roll-up call it after a successful write. The
// bus is installed once per process (scripts/worker.ts, api/context.ts); without one (tests,
// one-off scripts) announcing does nothing, so the pipeline never depends on it.

let installed: ProjectEventBus | undefined;

export function setProjectEventBus(bus: ProjectEventBus | undefined): void {
  installed = bus;
}

export function getProjectEventBus(): ProjectEventBus | undefined {
  return installed;
}

type ProjectLookup = Pick<PrismaClient, 'videoProject'>;

/**
 * Announce that a project changed. Never throws and never blocks the caller for long: callers
 * `void` it. Without the organisation id the project row is read once to find it.
 */
export async function announceProjectChange(
  db: ProjectLookup,
  input: { projectId: string; organisationId?: string },
): Promise<void> {
  const bus = installed;
  if (!bus) return;
  try {
    const organisationId =
      input.organisationId ??
      (
        await db.videoProject.findUnique({
          where: { id: input.projectId },
          select: { organisationId: true },
        })
      )?.organisationId;
    if (!organisationId) return;
    await bus.publish(organisationId, { projectId: input.projectId });
  } catch (err) {
    rootLogger.warn({ err, projectId: input.projectId }, 'live project event not announced');
  }
}
