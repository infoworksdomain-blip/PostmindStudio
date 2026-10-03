import type { Prisma, PrismaClient, SafetyReview, VideoProjectState } from '@prisma/client';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { AuditEntry } from '../../audit';
import { ConflictError, NotFoundError } from '../../errors';
import { notifyGenerationComplete } from '../notifications/events';
import { notifySafely, type Notifier } from '../notifications/notifier';
import {
  currentRunId,
  failProject,
  mergeProjectMetadata,
  projectMetadata,
  transitionProject,
} from '../pipeline/project-state';
import {
  evaluateContentSafety,
  qualityPassed,
  summarise,
  type ContentSafetyState,
  type QualityCheck,
} from '../pipeline/quality-checks';
import { SAFETY_REVIEW_ACTOR, type SafetyReviewMarker } from '../pipeline/safety-review';
import { jobIds, type JobQueue } from '../queue/enqueue';
import type { ProjectJobData } from '../queue/queues';
import type { AssetStorage } from '../storage';
import { toPlanTier } from './catalog';
import { projectLabel, projectNameParam } from '../../project-name';

// BACKLOG 13.17 / spec 16.4 — the staff side of the content-safety review queue
// (pipeline/safety-review.ts opens the reviews).
//   GET  /admin/safety-reviews?state=PENDING   the queue, oldest first, with a preview link
//   POST /admin/safety-reviews/:id/decision    ALLOW resumes the run, BLOCK fails it
// ALLOW on a script review moves PLANNING → ASSETS_QUEUED and enqueues the planned shots. ALLOW
// on a content review marks the flagged renders' content-safety check as allowed and finishes the
// quality gate (READY_FOR_REVIEW, or QUALITY_FAILED when another check failed). A reviewed video
// is never auto-approved: a person approves it. BLOCK fails the project with the note.
//
// 20.21: a content review that 20.19 opened only because no content-safety provider existed is
// released without staff (releaseNoProviderSafetyReview): the flagged checks become "Not scanned"
// and the quality gate finishes as it does today without a provider. Used by the worker's next
// quality-gate pass and by scripts/ops/release-safety-holds.ts.

export const SAFETY_REVIEW_STATES = ['PENDING', 'ALLOWED', 'BLOCKED'] as const;

export const listSafetyReviewsQuery = z.object({
  state: z.enum(SAFETY_REVIEW_STATES).default('PENDING'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(64).optional(),
});

export const safetyDecisionInput = z
  .object({
    decision: z.enum(['ALLOW', 'BLOCK']),
    note: z.string().trim().min(3).max(1_000),
  })
  .strict();

export type SafetyDecisionInput = z.infer<typeof safetyDecisionInput>;

export interface SafetyReviewDeps {
  db: PrismaClient;
  queue: JobQueue;
  storage: AssetStorage;
  logger: Logger;
  notifier?: Notifier;
  audit: (entry: AuditEntry) => void;
  now: () => number;
}

const SCRIPT_EXCERPT_CHARS = 1_500;

async function previewUrl(
  deps: Pick<SafetyReviewDeps, 'db' | 'storage'>,
  review: SafetyReview,
): Promise<string | null> {
  const renderId = review.renderIds[0];
  if (!renderId) return null;
  const render = await deps.db.videoRender.findUnique({
    where: { id: renderId },
    select: { s3Bucket: true, s3Key: true },
  });
  return render ? deps.storage.signedUrl(render.s3Bucket, render.s3Key) : null;
}

export async function listSafetyReviews(
  deps: Pick<SafetyReviewDeps, 'db' | 'storage'>,
  query: z.infer<typeof listSafetyReviewsQuery>,
) {
  const rows = await deps.db.safetyReview.findMany({
    where: { state: query.state },
    orderBy: [{ createdAt: query.state === 'PENDING' ? 'asc' : 'desc' }, { id: 'asc' }],
    take: query.limit + 1,
    ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
  });
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const projects = await deps.db.videoProject.findMany({
    where: { id: { in: page.map((r) => r.projectId) } },
    select: {
      id: true,
      name: true,
      state: true,
      scripts: { select: { targetPlatform: true, fullText: true } },
    },
  });
  const data = await Promise.all(
    page.map(async (review) => {
      const project = projects.find((p) => p.id === review.projectId);
      return {
        id: review.id,
        organisationId: review.organisationId,
        projectId: review.projectId,
        projectName: project?.name ?? null,
        projectState: project?.state ?? null,
        kind: review.kind,
        state: review.state,
        reason: review.reason,
        details: review.details,
        previewUrl: review.kind === 'content' ? await previewUrl(deps, review) : null,
        scripts:
          review.kind === 'script'
            ? (project?.scripts ?? []).map((s) => ({
                platform: s.targetPlatform,
                excerpt: s.fullText.slice(0, SCRIPT_EXCERPT_CHARS),
              }))
            : [],
        decisionNote: review.decisionNote,
        decidedByUserId: review.decidedByUserId,
        decidedAt: review.decidedAt,
        createdAt: review.createdAt,
      };
    }),
  );
  const pending = await deps.db.safetyReview.count({ where: { state: 'PENDING' } });
  return {
    data,
    pendingCount: pending,
    hasMore,
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
  };
}

function jobData(review: SafetyReview): ProjectJobData {
  return {
    projectId: review.projectId,
    organisationId: review.organisationId,
    runId: review.runId,
    planTier: toPlanTier(review.planTier),
  };
}

/** Script ALLOW: the plan was stored when the run paused; send its shots to Layer 3. */
async function resumeScript(deps: SafetyReviewDeps, review: SafetyReview): Promise<void> {
  const moved = await transitionProject(deps.db, {
    projectId: review.projectId,
    runId: review.runId,
    from: ['PLANNING'],
    to: 'ASSETS_QUEUED',
  });
  if (!moved) return;
  const shots = await deps.db.videoShot.findMany({
    where: { script: { projectId: review.projectId }, state: { in: ['PLANNED', 'QUEUED'] } },
    select: { id: true },
    orderBy: [{ scriptId: 'asc' }, { sortOrder: 'asc' }],
  });
  for (const shot of shots) {
    const job = { ...jobData(review), shotId: shot.id };
    await deps.queue.add('generate-asset', job, { jobId: jobIds.generateAsset(job) });
  }
}

function checksOf(value: Prisma.JsonValue | null): QualityCheck[] {
  return Array.isArray(value) ? (value as unknown as QualityCheck[]) : [];
}

type FinishDeps = Pick<SafetyReviewDeps, 'db' | 'logger' | 'notifier' | 'now'>;

/**
 * Rewrite the flagged renders' checks with `rewrite`, then finish the quality gate for this run
 * (READY_FOR_REVIEW, or QUALITY_FAILED when another check failed). True when the project reached
 * READY_FOR_REVIEW.
 */
async function finishContentReview(
  deps: FinishDeps,
  review: SafetyReview,
  rewrite: (check: QualityCheck) => QualityCheck,
): Promise<boolean> {
  const renderIds = Object.values(
    (projectMetadata(
      (
        await deps.db.videoProject.findUniqueOrThrow({
          where: { id: review.projectId },
          select: { metadata: true },
        })
      ).metadata,
    ).renders as Record<string, string> | undefined) ?? {},
  );
  const renders = await deps.db.videoRender.findMany({
    where: { id: { in: renderIds }, projectId: review.projectId },
  });
  const results: Array<{ platform: string; checks: QualityCheck[] }> = [];
  for (const render of renders) {
    let checks = checksOf(render.qualityIssues);
    if (review.renderIds.includes(render.id)) {
      checks = checks.map(rewrite);
      await deps.db.videoRender.update({
        where: { id: render.id },
        data: {
          qualityCheckState: qualityPassed(checks) ? 'PASSED' : 'FAILED',
          qualityIssues: checks as unknown as Prisma.InputJsonValue,
        },
      });
    }
    results.push({ platform: render.targetPlatform, checks });
  }
  const allPassed = results.length > 0 && results.every((r) => qualityPassed(r.checks));
  const moved = await transitionProject(deps.db, {
    projectId: review.projectId,
    runId: review.runId,
    from: ['QUALITY_CHECKING'],
    to: allPassed ? 'READY_FOR_REVIEW' : 'QUALITY_FAILED',
    data: allPassed
      ? { completedAt: new Date(deps.now()), errorReason: null }
      : { errorReason: `quality_failed: ${summarise(results)}`.slice(0, 2_000) },
  });
  // Spec 14.4 "Generation complete".
  if (moved && allPassed) await notifyGenerationComplete(deps, jobData(review));
  return moved && allPassed;
}

/** Content ALLOW: clear the flagged checks, then finish the quality gate for this run. */
async function resumeContent(
  deps: SafetyReviewDeps,
  review: SafetyReview,
  note: string,
): Promise<void> {
  // No auto-approval: a reviewed video goes to a person.
  await finishContentReview(deps, review, (c) =>
    c.code === 'content_safety' && c.status === 'failed' && c.severity === 'error'
      ? {
          ...c,
          status: 'passed',
          severity: 'info',
          detail: `Allowed by Trust & Safety review (${c.detail}): ${note}`.slice(0, 1_000),
          // 17.9: shown in the reader's language; the reviewer's note stays as written.
          detailKey: 'allowedByReview' as const,
          detailParams: { note: note.slice(0, 1_000) },
        }
      : c,
  );
}

/** The check detail 20.19 wrote when the scan could not run for want of a provider. */
export const NO_PROVIDER_SCAN_DETAIL = 'Scan could not run: no content-safety provider available';

export const NO_PROVIDER_RELEASE_NOTE =
  'Released automatically: no content-safety provider is configured (20.21), so the video was not scanned.';

const isNoProviderCheck = (c: QualityCheck) =>
  c.code === 'content_safety' &&
  c.status === 'failed' &&
  c.severity === 'error' &&
  c.detail === NO_PROVIDER_SCAN_DETAIL;

/**
 * 20.21: true for a content review whose every flagged render was flagged only because no
 * content-safety provider existed (20.19). A review with any real flag is not one.
 */
export function isNoProviderSafetyReview(review: Pick<SafetyReview, 'kind' | 'details'>): boolean {
  if (review.kind !== 'content' || !Array.isArray(review.details)) return false;
  const details: unknown[] = review.details;
  return (
    details.length > 0 &&
    details.every(
      (d) =>
        typeof d === 'object' &&
        d !== null &&
        (d as { detail?: unknown }).detail === NO_PROVIDER_SCAN_DETAIL,
    )
  );
}

export type ReleaseOutcome = 'released' | 'not_pending' | 'not_no_provider' | 'not_found';

export interface ReleaseOptions {
  /** Runs after the project reached READY_FOR_REVIEW (the worker passes auto-approval). */
  afterReady?: (job: ProjectJobData) => Promise<unknown>;
}

/**
 * 20.21: release one pending no-provider content review. The review is closed as ALLOWED by the
 * system actor with NO_PROVIDER_RELEASE_NOTE (claimed atomically, so a staff decision and a
 * release never both apply); for the run it paused, the flagged checks become "Not scanned"
 * (not_run) and the quality gate finishes. The customer gets no safety-review message (there was
 * no review), only the usual "Generation complete".
 */
export async function releaseNoProviderSafetyReview(
  deps: Pick<SafetyReviewDeps, 'db' | 'logger' | 'notifier' | 'audit' | 'now'>,
  id: string,
  options: ReleaseOptions = {},
): Promise<ReleaseOutcome> {
  const existing = await deps.db.safetyReview.findUnique({ where: { id } });
  if (!existing) return 'not_found';
  if (existing.state !== 'PENDING') return 'not_pending';
  if (!isNoProviderSafetyReview(existing)) return 'not_no_provider';
  const decidedAt = new Date(deps.now());
  const claimed = await deps.db.safetyReview.updateMany({
    where: { id, state: 'PENDING' },
    data: {
      state: 'ALLOWED',
      decidedByUserId: SAFETY_REVIEW_ACTOR,
      decisionNote: NO_PROVIDER_RELEASE_NOTE,
      decidedAt,
    },
  });
  if (claimed.count === 0) return 'not_pending';
  const review = await deps.db.safetyReview.findUniqueOrThrow({ where: { id } });

  const project = await deps.db.videoProject.findUnique({ where: { id: review.projectId } });
  const current = Boolean(project && !project.deletedAt && currentRunId(project) === review.runId);
  let ready = false;
  if (current) {
    const marker: SafetyReviewMarker = {
      id: review.id,
      kind: 'content',
      state: 'ALLOWED',
      reason: review.reason,
      at: decidedAt.toISOString(),
      note: NO_PROVIDER_RELEASE_NOTE,
    };
    const contentSafety: ContentSafetyState = { state: 'skipped', reason: 'no_provider' };
    await mergeProjectMetadata(deps.db, {
      projectId: review.projectId,
      runId: review.runId,
      patch: { safetyReview: marker, contentSafety },
    });
    const skipped = evaluateContentSafety({ skipped: 'no_provider' });
    ready = await finishContentReview(deps, review, (c) => (isNoProviderCheck(c) ? skipped : c));
    if (ready && options.afterReady) await options.afterReady(jobData(review));
  }
  deps.audit({
    actorUserId: SAFETY_REVIEW_ACTOR,
    organisationId: review.organisationId,
    action: 'studio.safety_review.release',
    resource: { type: 'safety_review', id },
    metadata: {
      reason: 'no_provider',
      projectId: review.projectId,
      runId: review.runId,
      runCurrent: current,
      readyForReview: ready,
    },
  });
  deps.logger.info(
    { reviewId: id, projectId: review.projectId, runCurrent: current, readyForReview: ready },
    'no-provider safety hold released',
  );
  return 'released';
}

export async function decideSafetyReview(
  deps: SafetyReviewDeps,
  actor: { userId: string; organisationId: string },
  id: string,
  input: SafetyDecisionInput,
): Promise<{ review: SafetyReview; project: { id: string; state: VideoProjectState | null } }> {
  const existing = await deps.db.safetyReview.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Safety review not found');
  if (existing.state !== 'PENDING')
    throw new ConflictError(`This review was already decided (${existing.state})`);
  const decidedAt = new Date(deps.now());
  const state = input.decision === 'ALLOW' ? 'ALLOWED' : 'BLOCKED';
  const claimed = await deps.db.safetyReview.updateMany({
    where: { id, state: 'PENDING' },
    data: { state, decidedByUserId: actor.userId, decisionNote: input.note, decidedAt },
  });
  if (claimed.count === 0) throw new ConflictError('This review was decided concurrently');
  const review = await deps.db.safetyReview.findUniqueOrThrow({ where: { id } });

  const project = await deps.db.videoProject.findUnique({ where: { id: review.projectId } });
  const current = project && !project.deletedAt && currentRunId(project) === review.runId;
  if (current) {
    const marker: SafetyReviewMarker = {
      id: review.id,
      kind: review.kind as SafetyReviewMarker['kind'],
      state,
      reason: review.reason,
      at: decidedAt.toISOString(),
      note: input.note,
    };
    await mergeProjectMetadata(deps.db, {
      projectId: review.projectId,
      runId: review.runId,
      patch: { safetyReview: marker },
    });
    if (input.decision === 'BLOCK') {
      await failProject(deps.db, {
        projectId: review.projectId,
        runId: review.runId,
        reason: `${review.kind}_safety_blocked_by_review: ${input.note}`,
      });
    } else if (review.kind === 'script') {
      await resumeScript(deps, review);
    } else {
      await resumeContent(deps, review, input.note);
    }
  } else {
    deps.logger.info({ reviewId: id }, 'safety review decided for a run that has moved on');
  }

  deps.audit({
    actorUserId: actor.userId,
    organisationId: actor.organisationId,
    action: 'studio.safety_review.decide',
    resource: { type: 'safety_review', id },
    metadata: {
      decision: input.decision,
      note: input.note,
      projectId: review.projectId,
      reviewOrganisationId: review.organisationId,
      kind: review.kind,
      runCurrent: Boolean(current),
    },
  });
  if (project) {
    await notifySafely(deps, {
      organisationId: review.organisationId,
      userId: project.createdByUserId,
      kind: 'safety_review',
      title:
        input.decision === 'ALLOW'
          ? `“${projectLabel(project.name)}” passed its content-safety review`
          : `“${projectLabel(project.name)}” was blocked by a content-safety review`,
      body:
        input.decision === 'ALLOW' ? 'Generation continues.' : `Trust & Safety note: ${input.note}`,
      link: `/projects/${project.id}`,
      dedupeKey: `safety_review_decided:${review.id}`,
      message:
        input.decision === 'ALLOW'
          ? { key: 'safetyReviewAllowed', params: { name: projectNameParam(project.name) } }
          : {
              key: 'safetyReviewBlocked',
              params: { name: projectNameParam(project.name), note: input.note },
            },
    });
  }
  const after = await deps.db.videoProject.findUnique({
    where: { id: review.projectId },
    select: { id: true, state: true },
  });
  return { review, project: { id: review.projectId, state: after?.state ?? null } };
}
