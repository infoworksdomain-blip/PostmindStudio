import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { AuditEntry } from '../../audit';
import type { CostCapPausedError, CostCapScope } from '../../errors';
import { utcDayKey, utcMonthKey } from '../cost/caps';
import { createKillSwitch, createPrismaFlagStore, type KillSwitch } from '../kill-switch';
import { notifySafely, type Notifier } from '../notifications/notifier';
import { mergeProjectMetadata, projectMetadata } from '../pipeline/project-state';
import type { JobQueue } from '../queue/enqueue';
import type { JobName, ProjectJobData } from '../queue/queues';
import {
  enqueueStage,
  recordedPlanTier,
  startResumeRun,
  TERMINAL_SHOT_STATES,
  withShots,
  type ProjectRow,
} from './redrive';
import { projectLabel, projectNameParam } from '../../project-name';

// BACKLOG 13.20 — auto-resume of projects paused by the organisation's daily or monthly cost cap
// (spec 12.5 "jobs pause"; runbooks/cost-runaway.md). When a job hits CostCapPausedError the
// runtime fails the project as `cost_cap_paused: …` and records metadata.costPause { scope,
// job, period }. A rollover job (00:05 UTC every day, which includes the 1st of the month) resumes
// every such project whose cap period has ended, from the stage that paused, through the same
// resume path as the kill-switch re-drive (services/redrive.ts): paid-for assets and renders are
// reused, the run gets a new runId. If the cap is still exhausted (e.g. staff lowered it), the
// guard pauses it again and it waits for the next rollover — a pause is resumed at most once per
// period.
//   - Projects opt out with PATCH /projects/:id { autoResume: false } (metadata.autoResume).
//   - Project-budget pauses (raise the budget) and the global cap (staff) are never auto-resumed.
//   - Anything that cannot be resumed cleanly is skipped and reported, never regenerated.

export const AUTO_RESUME_ACTOR = 'system:auto-resume';
export const AUTO_RESUME_SCOPES: readonly CostCapScope[] = ['org_daily', 'org_monthly'];
/** 00:05 UTC every day. The 1st of the month is a day like any other: monthly pauses resume then. */
export const AUTO_RESUME_SCHEDULE = '5 0 * * *';
const LOOKBACK_MS = 40 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 200;

export interface CostPauseMarker {
  scope: CostCapScope;
  /** The job that hit the cap: decides the stage to resume from. */
  job: JobName;
  /** The cap period that was exhausted: YYYY-MM-DD (daily) or YYYY-MM (monthly). */
  period: string;
  at: string;
}

export function capPeriod(scope: CostCapScope, at: Date): string {
  return scope === 'org_monthly' ? utcMonthKey(at) : utcDayKey(at);
}

/** Runtime hook: remember which cap (and stage) paused this run. Best effort. */
export async function recordCostPause(
  deps: { db: Pick<PrismaClient, '$executeRaw'>; now: () => number },
  data: { projectId?: string; runId: string },
  job: JobName,
  err: CostCapPausedError,
): Promise<void> {
  if (!data.projectId) return;
  const now = new Date(deps.now());
  const marker: CostPauseMarker = {
    scope: err.scope,
    job,
    period: capPeriod(err.scope, now),
    at: now.toISOString(),
  };
  await mergeProjectMetadata(deps.db, {
    projectId: data.projectId,
    runId: data.runId,
    patch: { costPause: marker },
  });
}

export function autoResumeEnabled(metadata: unknown): boolean {
  return projectMetadata(metadata as never).autoResume !== false;
}

function pauseOf(metadata: unknown): CostPauseMarker | undefined {
  const value = projectMetadata(metadata as never).costPause as CostPauseMarker | undefined;
  return value && typeof value.scope === 'string' && typeof value.period === 'string'
    ? value
    : undefined;
}

const STAGE_BY_JOB: Partial<Record<JobName, 'planning' | 'assets'>> = {
  'plan-project': 'planning',
  'generate-asset': 'assets',
  'compose-video': 'assets',
  'poll-render': 'assets',
  'run-quality-gate': 'assets',
};

export interface AutoResumeItem {
  projectId: string;
  organisationId: string;
  action: 'resumed' | 'skipped';
  scope?: CostCapScope;
  stage?: 'planning' | 'assets';
  reason?: string;
}

export interface AutoResumeDeps {
  db: PrismaClient;
  queue: JobQueue;
  logger: Logger;
  audit: (entry: AuditEntry) => void;
  notifier?: Notifier;
  now: () => number;
  killSwitch?: KillSwitch;
}

/** Why a paused project is not resumed now; undefined = resume it. */
export function skipReason(project: ProjectRow, now: Date): string | undefined {
  const pause = pauseOf(project.metadata);
  if (!pause) return 'pause scope not recorded';
  if (!AUTO_RESUME_SCOPES.includes(pause.scope))
    return `${pause.scope} pauses are not resumed automatically`;
  if (!autoResumeEnabled(project.metadata)) return 'auto-resume turned off for this project';
  if (pause.period === capPeriod(pause.scope, now)) return 'cap period has not rolled over yet';
  if (!STAGE_BY_JOB[pause.job]) return `paused in ${pause.job}; resume by hand`;
  if (!recordedPlanTier(project)) return 'plan tier not recorded on the run';
  const otherFailures = project.scripts
    .flatMap((s) => s.shots)
    .filter((s) => s.state === 'FAILED' && !s.errorReason?.includes('cost_cap_paused'));
  if (otherFailures.length > 0) return 'shots also failed for other reasons';
  return undefined;
}

async function resumeOne(
  deps: AutoResumeDeps & { killSwitch: KillSwitch },
  project: ProjectRow,
  now: Date,
  dryRun: boolean,
): Promise<AutoResumeItem> {
  const base = { projectId: project.id, organisationId: project.organisationId };
  const pause = pauseOf(project.metadata);
  const reason = skipReason(project, now);
  if (reason || !pause) return { ...base, action: 'skipped', scope: pause?.scope, reason };
  const stage = STAGE_BY_JOB[pause.job] ?? 'assets';
  const kill = await deps.killSwitch.check({
    organisationId: project.organisationId,
    projectId: project.id,
  });
  if (kill.killed)
    return { ...base, action: 'skipped', scope: pause.scope, reason: `kill switch ${kill.level}` };
  if (dryRun) return { ...base, action: 'resumed', scope: pause.scope, stage };

  const runId = await startResumeRun(deps.db, project, stage, {
    costPause: null,
    autoResumed: { scope: pause.scope, period: pause.period, at: now.toISOString() },
  });
  if (!runId)
    return { ...base, action: 'skipped', scope: pause.scope, reason: 'changed concurrently' };
  const data: ProjectJobData = {
    projectId: project.id,
    organisationId: project.organisationId,
    runId,
    planTier: recordedPlanTier(project) ?? 'STANDARD',
  };
  const pendingShots =
    stage === 'assets'
      ? project.scripts
          .flatMap((s) => s.shots)
          .filter((s) => s.state === 'FAILED' || !TERMINAL_SHOT_STATES.includes(s.state))
      : [];
  await enqueueStage(
    deps.queue,
    data,
    stage === 'planning' ? 'plan' : 'assets',
    pendingShots,
    project,
  );
  deps.audit({
    actorUserId: AUTO_RESUME_ACTOR,
    organisationId: project.organisationId,
    action: 'studio.project.auto_resume',
    resource: { type: 'video_project', id: project.id },
    metadata: { scope: pause.scope, period: pause.period, stage, runId },
  });
  await notifySafely(deps, {
    organisationId: project.organisationId,
    userId: project.createdByUserId,
    // The resume is the end of a cost pause: same preference as the pause alert.
    kind: 'cost_alert',
    title: `“${projectLabel(project.name)}” resumed automatically`,
    body:
      pause.scope === 'org_monthly'
        ? 'A new month started, so generation continued from where it paused.'
        : 'A new day started (UTC), so generation continued from where it paused.',
    link: `/projects/${project.id}`,
    dedupeKey: `auto_resume:${project.id}:${pause.scope}:${pause.period}`,
    message: {
      key: pause.scope === 'org_monthly' ? 'autoResumedMonthly' : 'autoResumedDaily',
      params: { name: projectNameParam(project.name) },
    },
  });
  return { ...base, action: 'resumed', scope: pause.scope, stage };
}

export async function resumeCostPausedProjects(
  deps: AutoResumeDeps,
  options: { limit?: number; dryRun?: boolean } = {},
): Promise<{ considered: number; resumed: number; skipped: number; items: AutoResumeItem[] }> {
  const now = new Date(deps.now());
  const killSwitch =
    deps.killSwitch ?? createKillSwitch({ store: createPrismaFlagStore(deps.db), ttlMs: 0 });
  const projects = await deps.db.videoProject.findMany({
    where: {
      state: 'FAILED',
      deletedAt: null,
      errorReason: { startsWith: 'cost_cap_paused' },
      updatedAt: { gte: new Date(now.getTime() - LOOKBACK_MS) },
    },
    include: withShots,
    orderBy: { updatedAt: 'asc' },
    take: options.limit ?? DEFAULT_LIMIT,
  });
  const items: AutoResumeItem[] = [];
  for (const project of projects) {
    try {
      items.push(await resumeOne({ ...deps, killSwitch }, project, now, options.dryRun ?? false));
    } catch (err) {
      deps.logger.error({ err, projectId: project.id }, 'auto-resume failed for a project');
      items.push({
        projectId: project.id,
        organisationId: project.organisationId,
        action: 'skipped',
        reason: 'error while resuming',
      });
    }
  }
  const resumed = items.filter((i) => i.action === 'resumed').length;
  return { considered: items.length, resumed, skipped: items.length - resumed, items };
}
