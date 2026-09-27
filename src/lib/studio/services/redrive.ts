import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, VideoProject, VideoShot } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, ValidationError, type KillSwitchLevel } from '../../errors';
import { createKillSwitch, createPrismaFlagStore, type KillSwitch } from '../kill-switch';
import { ACTIVE_PIPELINE_STATES, currentRunId, projectMetadata } from '../pipeline/project-state';
import { pendingSafetyReview } from '../pipeline/safety-review';
import type { PlanTier } from '../providers/router';
import { jobIds, type JobQueue } from '../queue/enqueue';
import type { ProjectJobData } from '../queue/queues';
import { toPlanTier } from './catalog';
import { retryPublicationFor } from './publications';

// Operator bulk re-drive (Phase 12; runbooks/kill-switch.md, backup-recovery.md). Two scopes:
//
//   kill_switch — work a kill switch failed while it was engaged. Projects resume from the stage
//                 that was killed, keeping everything already paid for (shots with assets and
//                 finished renders are reused; only missing work runs). Publications are retried
//                 through the same path as POST /publications/:id/retry.
//   stuck       — projects in an active pipeline state that have not moved for stuckMinutes
//                 (e.g. their jobs were lost with Redis): the job for the current stage is added
//                 again under the current runId. Job ids are deterministic per run, so a job that
//                 still exists is not duplicated.
//
// Anything that cannot be resumed cleanly is skipped and reported, never regenerated wholesale.
// dryRun (the default) returns the plan and changes nothing.

export const KILL_SWITCH_LEVELS = [
  'global',
  'workspace',
  'project',
  'provider',
  'platform',
] as const satisfies readonly KillSwitchLevel[];

export const MAX_SINCE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const redriveInput = z
  .object({
    scope: z.enum(['kill_switch', 'stuck']),
    level: z.enum(KILL_SWITCH_LEVELS).optional(),
    organisationId: z.string().trim().min(1).max(128).optional(),
    since: z.iso.datetime().optional(),
    stuckMinutes: z.number().int().min(10).max(10_080).default(30),
    dryRun: z.boolean().default(true),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();

export type RedriveInput = z.infer<typeof redriveInput>;

export type RedriveAction =
  'resume_planning' | 'resume_assets' | 'retry_publication' | 'reenqueue' | 'skipped';

export interface RedriveItem {
  kind: 'project' | 'publication';
  id: string;
  organisationId: string;
  action: RedriveAction;
  /** What runs next: the job name(s) added (or that would be added in a dry run). */
  jobs?: string[];
  skippedReason?: string;
}

export interface RedriveResult {
  dryRun: boolean;
  scope: RedriveInput['scope'];
  counts: { considered: number; redriven: number; skipped: number };
  items: RedriveItem[];
}

export interface RedriveDeps {
  db: PrismaClient;
  queue: JobQueue;
  now: () => number;
  /** Defaults to an uncached flag reader, so a just-released switch is seen immediately. */
  killSwitch?: KillSwitch;
}

export type ShotRow = Pick<VideoShot, 'id' | 'state' | 'errorReason'>;
export type ProjectRow = VideoProject & { scripts: Array<{ shots: ShotRow[] }> };

/** `kill_switch_<level>` anywhere in a failure reason (failure handlers prefix their stage). */
const KILL_REASON = /kill_switch_(global|workspace|project|provider|platform)\b/;
export const TERMINAL_SHOT_STATES = ['READY', 'SKIPPED', 'FAILED'];

export function killLevelOf(reason: string | null): KillSwitchLevel | undefined {
  return reason?.match(KILL_REASON)?.[1] as KillSwitchLevel | undefined;
}

/** The pipeline stage a kill-switched project failed in, from its failure handler's prefix. */
export function killedStage(reason: string | null): 'planning' | 'assets' | undefined {
  if (!reason || !killLevelOf(reason)) return undefined;
  if (reason.startsWith('planning_failed: kill_switch_')) return 'planning';
  if (
    reason.startsWith('asset_generation_failed: ') ||
    reason.startsWith('composition_failed: kill_switch_') ||
    reason.startsWith('quality_gate_error: kill_switch_')
  ) {
    return 'assets';
  }
  return undefined;
}

/** Publication reasons: publish-video stores the reason as-is, fire-scheduled prefixes it. */
export function isKilledPublication(reason: string | null): boolean {
  return Boolean(reason && /^(scheduling failed: )?kill_switch_/.test(reason));
}

export function recordedPlanTier(project: Pick<VideoProject, 'metadata'>): PlanTier | undefined {
  const value = projectMetadata(project.metadata).planTier;
  return typeof value === 'string' ? toPlanTier(value) : undefined;
}

const skip = (
  kind: RedriveItem['kind'],
  row: { id: string; organisationId: string },
  skippedReason: string,
): RedriveItem => ({
  kind,
  id: row.id,
  organisationId: row.organisationId,
  action: 'skipped',
  skippedReason,
});

function validateWindow(input: RedriveInput, now: number): Date | undefined {
  if (input.scope === 'stuck') {
    if (input.level) throw new ValidationError('level applies to the kill_switch scope only');
    return undefined;
  }
  if (!input.since) throw new ValidationError('since is required for the kill_switch scope');
  const since = new Date(input.since);
  if (since.getTime() > now) throw new ValidationError('since must be in the past');
  if (since.getTime() < now - MAX_SINCE_DAYS * DAY_MS) {
    throw new ValidationError(`since must be within the last ${MAX_SINCE_DAYS} days`);
  }
  return since;
}

export async function redrive(deps: RedriveDeps, input: RedriveInput): Promise<RedriveResult> {
  const since = validateWindow(input, deps.now());
  const killSwitch =
    deps.killSwitch ?? createKillSwitch({ store: createPrismaFlagStore(deps.db), ttlMs: 0 });
  const ctx = { ...deps, killSwitch };
  const items =
    input.scope === 'stuck'
      ? await redriveStuck(ctx, input)
      : await redriveKilled(ctx, input, since ?? new Date(deps.now()));
  const skipped = items.filter((i) => i.action === 'skipped').length;
  return {
    dryRun: input.dryRun,
    scope: input.scope,
    counts: { considered: items.length, redriven: items.length - skipped, skipped },
    items,
  };
}

type Ctx = RedriveDeps & { killSwitch: KillSwitch };

export const withShots = {
  scripts: { select: { shots: { select: { id: true, state: true, errorReason: true } } } },
} as const;

// ---------------------------------------------------------------- kill_switch scope

async function redriveKilled(ctx: Ctx, input: RedriveInput, since: Date): Promise<RedriveItem[]> {
  const reason = { contains: input.level ? `kill_switch_${input.level}` : 'kill_switch_' };
  const org = input.organisationId ? { organisationId: input.organisationId } : {};
  const projects = await ctx.db.videoProject.findMany({
    where: {
      ...org,
      state: 'FAILED',
      deletedAt: null,
      errorReason: reason,
      updatedAt: { gte: since },
    },
    include: withShots,
    orderBy: { updatedAt: 'asc' },
    take: input.limit,
  });
  const publications = await ctx.db.videoPublication.findMany({
    where: { ...org, state: 'FAILED', errorReason: reason, updatedAt: { gte: since } },
    include: { project: { select: { metadata: true, deletedAt: true } } },
    orderBy: { updatedAt: 'asc' },
    take: Math.max(0, input.limit - projects.length),
  });
  const items: RedriveItem[] = [];
  for (const project of projects) items.push(await resumeKilledProject(ctx, project, input.dryRun));
  for (const publication of publications) {
    items.push(await retryKilledPublication(ctx, publication, input.dryRun));
  }
  return items;
}

async function stillKilled(
  ctx: Ctx,
  scope: { organisationId: string; projectId: string; platform?: string },
): Promise<string | undefined> {
  const status = await ctx.killSwitch.check(scope);
  return status.killed ? `kill_switch_still_engaged: ${status.level}` : undefined;
}

async function resumeKilledProject(
  ctx: Ctx,
  project: ProjectRow,
  dryRun: boolean,
): Promise<RedriveItem> {
  const stage = killedStage(project.errorReason);
  if (!stage) return skip('project', project, 'failure stage unknown; regenerate it by hand');
  const blocked = await stillKilled(ctx, {
    organisationId: project.organisationId,
    projectId: project.id,
  });
  if (blocked) return skip('project', project, blocked);
  const planTier = recordedPlanTier(project);
  if (!planTier) return skip('project', project, 'plan tier not recorded on the run');
  if (!currentRunId(project)) return skip('project', project, 'no run recorded');

  const shots = project.scripts.flatMap((s) => s.shots);
  const failedOtherwise = shots.filter((s) => s.state === 'FAILED' && !killLevelOf(s.errorReason));
  if (stage === 'assets' && failedOtherwise.length > 0) {
    return skip('project', project, 'shots also failed for reasons other than the kill switch');
  }
  const pendingShots =
    stage === 'assets'
      ? shots.filter((s) => s.state === 'FAILED' || !TERMINAL_SHOT_STATES.includes(s.state))
      : [];
  const jobs =
    stage === 'planning'
      ? ['plan-project']
      : pendingShots.length > 0 && project.sourceType !== 'SLIDESHOW'
        ? pendingShots.map(() => 'generate-asset')
        : ['compose-video'];
  const action: RedriveAction = stage === 'planning' ? 'resume_planning' : 'resume_assets';
  const item: RedriveItem = {
    kind: 'project',
    id: project.id,
    organisationId: project.organisationId,
    action,
    jobs,
  };
  if (dryRun) return item;

  const runId = await startResumeRun(ctx.db, project, stage);
  if (!runId) return skip('project', project, 'project changed concurrently');
  const data: ProjectJobData = {
    projectId: project.id,
    organisationId: project.organisationId,
    runId,
    planTier,
  };
  await enqueueStage(
    ctx.queue,
    data,
    stage === 'planning' ? 'plan' : 'assets',
    pendingShots,
    project,
  );
  return item;
}

/**
 * FAILED → QUEUED (planning) or ASSETS_QUEUED (assets) under a new runId: the killed run's jobs
 * are dead-lettered under the old run's job ids, which would otherwise swallow the re-adds.
 * The assets resume keeps metadata.renders (compose skips scripts already rendered) and resets
 * only the kill-switched shots; their recorded assets stay, so generate-asset won't re-pay.
 */
export async function startResumeRun(
  db: PrismaClient,
  project: ProjectRow,
  stage: 'planning' | 'assets',
  /** Extra metadata keys for the new run (13.20 auto-resume records why it resumed). */
  patch: Record<string, unknown> = {},
): Promise<string | undefined> {
  const runId = randomUUID();
  const metadata = projectMetadata(project.metadata);
  return db.$transaction(async (tx) => {
    const moved = await tx.videoProject.updateMany({
      where: {
        id: project.id,
        organisationId: project.organisationId,
        state: 'FAILED',
        updatedAt: project.updatedAt,
      },
      data: {
        state: stage === 'planning' ? 'QUEUED' : 'ASSETS_QUEUED',
        errorReason: null,
        completedAt: null,
        metadata: {
          ...metadata,
          runId,
          ...(stage === 'planning' && { renders: {} }),
          redrivenFrom: metadata.runId ?? null,
          ...patch,
        } as Prisma.InputJsonValue,
      },
    });
    if (moved.count === 0) return undefined;
    if (stage === 'assets') {
      await tx.videoShot.updateMany({
        where: { script: { projectId: project.id }, state: 'FAILED' },
        data: { state: 'QUEUED', errorReason: null },
      });
    }
    return runId;
  });
}

export async function enqueueStage(
  queue: JobQueue,
  data: ProjectJobData,
  stage: 'plan' | 'assets' | 'scan' | 'render' | 'quality',
  pendingShots: ShotRow[],
  project: Pick<VideoProject, 'sourceType'>,
): Promise<void> {
  switch (stage) {
    case 'plan':
      return queue.add('plan-project', data, { jobId: jobIds.planProject(data) });
    case 'scan':
      return queue.add('populate-slideshow', data, { jobId: jobIds.populateSlideshow(data) });
    case 'quality':
      return queue.add('run-quality-gate', data, { jobId: jobIds.runQualityGate(data) });
    case 'render':
      return queue.add('compose-video', data, { jobId: jobIds.composeVideo(data) });
    case 'assets':
      if (pendingShots.length === 0 || project.sourceType === 'SLIDESHOW') {
        return queue.add('compose-video', data, { jobId: jobIds.composeVideo(data) });
      }
      for (const shot of pendingShots) {
        const job = { ...data, shotId: shot.id };
        await queue.add('generate-asset', job, { jobId: jobIds.generateAsset(job) });
      }
  }
}

type PublicationRow = Prisma.VideoPublicationGetPayload<{
  include: { project: { select: { metadata: true; deletedAt: true } } };
}>;

async function retryKilledPublication(
  ctx: Ctx,
  publication: PublicationRow,
  dryRun: boolean,
): Promise<RedriveItem> {
  if (!isKilledPublication(publication.errorReason)) {
    return skip('publication', publication, 'not failed by the kill switch');
  }
  if (publication.project.deletedAt) return skip('publication', publication, 'project deleted');
  const blocked = await stillKilled(ctx, {
    organisationId: publication.organisationId,
    projectId: publication.projectId,
    platform: publication.platform,
  });
  if (blocked) return skip('publication', publication, blocked);
  const marker = (publication.metadata as { uploadStartedAt?: unknown } | null)?.uploadStartedAt;
  if (marker) {
    // An upload was started before the switch: the post may be live. A person must check.
    return skip('publication', publication, 'upload outcome unknown; check the platform first');
  }
  const item: RedriveItem = {
    kind: 'publication',
    id: publication.id,
    organisationId: publication.organisationId,
    action: 'retry_publication',
    jobs: ['publish-video'],
  };
  if (dryRun) return item;
  const planTier = recordedPlanTier(publication.project) ?? toPlanTier(undefined);
  try {
    await retryPublicationFor(
      ctx,
      { organisationId: publication.organisationId, planTier },
      publication.id,
    );
  } catch (err) {
    if (err instanceof ConflictError) return skip('publication', publication, err.message);
    throw err;
  }
  return item;
}

// ---------------------------------------------------------------- stuck scope

const STAGE_BY_STATE: Partial<
  Record<VideoProject['state'], 'plan' | 'scan' | 'assets' | 'render' | 'quality'>
> = {
  QUEUED: 'plan',
  PLANNING: 'plan',
  SCANNING: 'scan',
  ASSETS_QUEUED: 'assets',
  ASSETS_GENERATING: 'assets',
  RENDERING: 'render',
  QUALITY_CHECKING: 'quality',
};

const JOB_BY_STAGE = {
  plan: 'plan-project',
  scan: 'populate-slideshow',
  render: 'compose-video',
  quality: 'run-quality-gate',
} as const;

async function redriveStuck(ctx: Ctx, input: RedriveInput): Promise<RedriveItem[]> {
  const cutoff = new Date(ctx.now() - input.stuckMinutes * 60_000);
  const projects = await ctx.db.videoProject.findMany({
    where: {
      ...(input.organisationId && { organisationId: input.organisationId }),
      state: { in: [...ACTIVE_PIPELINE_STATES] },
      deletedAt: null,
      updatedAt: { lt: cutoff },
    },
    include: withShots,
    orderBy: { updatedAt: 'asc' },
    take: input.limit,
  });
  const items: RedriveItem[] = [];
  for (const project of projects) items.push(await reenqueueStuck(ctx, project, input.dryRun));
  return items;
}

async function reenqueueStuck(
  ctx: Ctx,
  project: ProjectRow,
  dryRun: boolean,
): Promise<RedriveItem> {
  const stage = STAGE_BY_STATE[project.state];
  if (!stage) return skip('project', project, `state ${project.state} is not re-drivable`);
  // 13.17: a run paused for a content-safety review is waiting for staff, not stuck.
  if (pendingSafetyReview(project.metadata))
    return skip('project', project, 'waiting for a content-safety review');
  const blocked = await stillKilled(ctx, {
    organisationId: project.organisationId,
    projectId: project.id,
  });
  if (blocked) return skip('project', project, blocked);
  const planTier = recordedPlanTier(project);
  if (!planTier) return skip('project', project, 'plan tier not recorded on the run');
  // SCANNING belongs to the slideshow auto-populate run (metadata.populate.id), not the pipeline run.
  const populate = projectMetadata(project.metadata).populate as { id?: unknown } | undefined;
  const runId = stage === 'scan' ? populate?.id : currentRunId(project);
  if (typeof runId !== 'string') return skip('project', project, 'no run recorded');

  const pendingShots = project.scripts
    .flatMap((s) => s.shots)
    .filter((s) => !TERMINAL_SHOT_STATES.includes(s.state));
  const jobs =
    stage !== 'assets'
      ? [JOB_BY_STAGE[stage]]
      : pendingShots.length > 0 && project.sourceType !== 'SLIDESHOW'
        ? pendingShots.map(() => 'generate-asset')
        : ['compose-video'];
  const item: RedriveItem = {
    kind: 'project',
    id: project.id,
    organisationId: project.organisationId,
    action: 'reenqueue',
    jobs,
  };
  if (dryRun) return item;
  const data: ProjectJobData = {
    projectId: project.id,
    organisationId: project.organisationId,
    runId,
    planTier,
  };
  await enqueueStage(ctx.queue, data, stage, pendingShots, project);
  return item;
}
