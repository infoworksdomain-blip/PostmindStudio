import type { Prisma, PrismaClient } from '@prisma/client';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import { ACTIVE_PIPELINE_STATES, currentRunId } from '../pipeline/project-state';
import { planCandidates } from '../providers/router';
import type { JobQueue } from '../queue/enqueue';
import type { GenerateAssetJobData, ProjectJobData } from '../queue/queues';
import type { DeadLetterQueue } from './dead-letter';
import { enqueueStage, startResumeRun, TERMINAL_SHOT_STATES, withShots } from './redrive';

// BACKLOG 15.D4 — "requeue-with-different-provider" (spec 11.5) for generate-asset jobs.
//
// Only generate-asset can honestly take a provider override: the worker reads the shot's
// providerRouting.preferredProviderId (the same field POST /shots/:id/regenerate sets) and the
// router tries it first *if it is a candidate for the shot's treatment and plan tier*
// (providers/router.ts: a preference reorders, it never adds a provider). Every other job type
// routes from a fixed candidate list with no per-job preference, so a providerId there is a 400.
//
// A dead-lettered generate-asset job has already run its failure handler: the shot is FAILED and,
// once every shot was terminal, compose failed the project as `asset_generation_failed`. Adding
// the same job again would do nothing (the worker skips terminal shots), so requeue:
//   - project still generating this run and the shot not terminal → add the job again;
//   - project FAILED at the asset stage of this run → resume the asset stage under a new run
//     (redrive.startResumeRun: failed shots reset, assets and renders already paid for are kept);
//   - anything else (a newer run, or the project moved on) → 409 with the next step.

export type RequeueOutcome =
  | { action: 'requeued'; providerId?: string }
  | {
      action: 'resumed_project';
      projectId: string;
      runId: string;
      jobs: number;
      providerId?: string;
    };

export interface RequeueDeps {
  db: PrismaClient;
  queue: DeadLetterQueue;
  jobs: JobQueue;
}

type ShotRow = Prisma.VideoShotGetPayload<{
  select: {
    id: true;
    state: true;
    visualTreatment: true;
    durationSec: true;
    providerRouting: true;
    script: { select: { projectId: true; project: { select: { organisationId: true } } } };
  };
}>;

/** 400 unless providerId is a router candidate for this shot on the job's plan tier. */
export function assertCandidate(
  shot: Pick<ShotRow, 'visualTreatment' | 'durationSec'>,
  planTier: GenerateAssetJobData['planTier'],
  providerId: string,
): void {
  let providerIds: string[];
  try {
    ({ providerIds } = planCandidates(
      { kind: 'shot', visualTreatment: shot.visualTreatment, durationSec: shot.durationSec },
      planTier,
    ));
  } catch (err) {
    if (err instanceof ValidationError) {
      throw new ValidationError(
        `${shot.visualTreatment} shots are built by composition; there is no provider to choose`,
      );
    }
    throw err;
  }
  if (!providerIds.includes(providerId)) {
    throw new ValidationError(
      `${providerId} is not a candidate for ${shot.visualTreatment} shots on the ${planTier} plan`,
      { candidates: providerIds },
    );
  }
}

async function loadShot(db: PrismaClient, data: GenerateAssetJobData): Promise<ShotRow> {
  const shot = await db.videoShot.findUnique({
    where: { id: data.shotId },
    select: {
      id: true,
      state: true,
      visualTreatment: true,
      durationSec: true,
      providerRouting: true,
      script: { select: { projectId: true, project: { select: { organisationId: true } } } },
    },
  });
  if (
    !shot ||
    shot.script.projectId !== data.projectId ||
    shot.script.project.organisationId !== data.organisationId
  ) {
    throw new NotFoundError('The shot this job generates no longer exists; remove the job instead');
  }
  return shot;
}

async function preferProvider(db: PrismaClient, shot: ShotRow, providerId: string | undefined) {
  if (!providerId) return;
  const routing = (shot.providerRouting as Record<string, unknown> | null) ?? {};
  await db.videoShot.update({
    where: { id: shot.id },
    data: {
      providerRouting: { ...routing, preferredProviderId: providerId } as Prisma.InputJsonValue,
    },
  });
}

export async function requeueGenerateAsset(
  deps: RequeueDeps,
  jobId: string,
  data: GenerateAssetJobData,
  providerId: string | undefined,
): Promise<RequeueOutcome> {
  const shot = await loadShot(deps.db, data);
  if (providerId) assertCandidate(shot, data.planTier, providerId);
  const project = await deps.db.videoProject.findUnique({
    where: { id: data.projectId },
    include: withShots,
  });
  if (!project || project.deletedAt) throw new ConflictError('The project has been deleted');
  if (currentRunId(project) !== data.runId) {
    throw new ConflictError(
      'The project has started a newer run since this job failed; remove this job and regenerate the shot (POST /shots/:id/regenerate with providerId) if it still needs a new clip',
    );
  }
  const terminal = TERMINAL_SHOT_STATES.includes(shot.state);
  const tag = providerId ? { providerId } : {};

  if (ACTIVE_PIPELINE_STATES.includes(project.state) && !terminal) {
    await preferProvider(deps.db, shot, providerId);
    await deps.queue.requeue(jobId);
    return { action: 'requeued', ...tag };
  }
  if (project.state === 'FAILED' && project.errorReason?.startsWith('asset_generation_failed')) {
    const pendingShots = project.scripts
      .flatMap((s) => s.shots)
      .filter((s) => s.state === 'FAILED' || !TERMINAL_SHOT_STATES.includes(s.state));
    await preferProvider(deps.db, shot, providerId);
    const runId = await startResumeRun(deps.db, project, 'assets', {
      requeuedFromDeadLetter: jobId,
    });
    if (!runId) throw new ConflictError('The project changed while requeueing; try again');
    const job: ProjectJobData = {
      projectId: project.id,
      organisationId: project.organisationId,
      runId,
      planTier: data.planTier,
      batch: data.batch,
    };
    await enqueueStage(deps.jobs, job, 'assets', pendingShots, project);
    // The dead-lettered job belongs to the old run; the new run's jobs replace it.
    await deps.queue.remove(jobId);
    return {
      action: 'resumed_project',
      projectId: project.id,
      runId,
      jobs: pendingShots.length || 1,
      ...tag,
    };
  }
  throw new ConflictError(
    `The project is ${project.state}; requeueing this job would not change it. Regenerate the shot from the review screen (POST /shots/:id/regenerate with providerId) instead`,
    { projectState: project.state },
  );
}
