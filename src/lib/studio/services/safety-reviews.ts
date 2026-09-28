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
import { qualityPassed, type QualityCheck } from '../pipeline/quality-checks';
import type { SafetyReviewMarker } from '../pipeline/safety-review';
import { jobIds, type JobQueue } from '../queue/enqueue';
import type { ProjectJobData } from '../queue/queues';
import { summarise } from '../queue/workers/run-quality-gate';
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

/** Content ALLOW: clear the flagged checks, then finish the quality gate for this run. */
async function resumeContent(
  deps: SafetyReviewDeps,
  review: SafetyReview,
  note: string,
): Promise<void> {
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
      checks = checks.map((c) =>
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
  // Spec 14.4 "Generation complete". No auto-approval: a reviewed video goes to a person.
  if (moved && allPassed) await notifyGenerationComplete(deps, jobData(review));
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
