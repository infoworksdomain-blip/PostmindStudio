import { Prisma, type PrismaClient, type SafetyReview } from '@prisma/client';
import type { Logger } from 'pino';
import type { AuditEntry } from '../../audit';
import { notifySafely, notifierFor, type Notifier } from '../notifications/notifier';
import { mergeProjectMetadata } from './project-state';
import { projectLabel, projectNameParam } from '../../project-name';

// BACKLOG 13.17 / spec 16.4 — content-safety review queue. Two pipeline results that used to
// fail the run closed now pause it for a Trust & Safety decision:
//   script  — the pre-generation script-safety classifier says REVIEW (plan-project, before any
//             Layer 3 spend; the plan is persisted, no shot is enqueued);
//   content — the content-safety provider flags a review-level class on a render and nothing is
//             block-level (none is built since 20.21, so this kind is not opened today)
//             (run-quality-gate; the project stays QUALITY_CHECKING).
// The project keeps its pipeline state; metadata.safetyReview says why it is not moving, and the
// stuck re-drive skips it. Staff decide with POST /admin/safety-reviews/:id/decision
// (services/safety-reviews.ts): ALLOW resumes the run, BLOCK fails it with the note.
// BLOCK-level results still fail immediately, as before.

export const SAFETY_REVIEW_ACTOR = 'system:studio-safety';

export type SafetyReviewKind = 'script' | 'content';

export interface OpenSafetyReviewInput {
  organisationId: string;
  projectId: string;
  runId: string;
  planTier: string;
  kind: SafetyReviewKind;
  reason: string;
  details: Prisma.InputJsonValue;
  renderIds?: string[];
}

export interface SafetyReviewHost {
  db: PrismaClient;
  logger: Logger;
  notifier?: Notifier;
  audit: (entry: AuditEntry) => void;
  now: () => number;
}

/** metadata.safetyReview while a run waits (and after the decision, for the UI). */
export interface SafetyReviewMarker {
  id: string;
  kind: SafetyReviewKind;
  state: 'PENDING' | 'ALLOWED' | 'BLOCKED';
  reason: string;
  at: string;
  note?: string;
}

export function pendingSafetyReview(metadata: unknown): SafetyReviewMarker | undefined {
  const marker =
    metadata && typeof metadata === 'object'
      ? (metadata as { safetyReview?: SafetyReviewMarker }).safetyReview
      : undefined;
  return marker?.state === 'PENDING' ? marker : undefined;
}

/** Idempotent per (project, run, kind): a retried job finds the review it already opened. */
export async function openSafetyReview(
  host: SafetyReviewHost,
  input: OpenSafetyReviewInput,
): Promise<SafetyReview> {
  const reason = input.reason.slice(0, 1_000);
  const review = await host.db.safetyReview.upsert({
    where: {
      projectId_runId_kind: { projectId: input.projectId, runId: input.runId, kind: input.kind },
    },
    create: {
      organisationId: input.organisationId,
      projectId: input.projectId,
      runId: input.runId,
      kind: input.kind,
      reason,
      details: input.details,
      renderIds: input.renderIds ?? [],
      planTier: input.planTier,
    },
    update: {},
  });
  const marker: SafetyReviewMarker = {
    id: review.id,
    kind: input.kind,
    state: review.state,
    reason,
    at: new Date(host.now()).toISOString(),
  };
  await mergeProjectMetadata(host.db, {
    projectId: input.projectId,
    runId: input.runId,
    patch: { safetyReview: marker },
  });
  host.audit({
    actorUserId: SAFETY_REVIEW_ACTOR,
    organisationId: input.organisationId,
    action: 'studio.safety_review.open',
    resource: { type: 'safety_review', id: review.id },
    metadata: { projectId: input.projectId, runId: input.runId, kind: input.kind, reason },
  });
  await notifyOpened(host, review);
  host.logger.warn(
    { projectId: input.projectId, reviewId: review.id, kind: input.kind },
    'run paused for a content-safety review',
  );
  return review;
}

async function notifyOpened(host: SafetyReviewHost, review: SafetyReview): Promise<void> {
  const project = await host.db.videoProject.findUnique({
    where: { id: review.projectId },
    select: { name: true, createdByUserId: true },
  });
  const name = project ? projectLabel(project.name) : 'A project';
  try {
    await notifierFor(host).notifyStaff({
      kind: 'safety_review',
      title: `Content-safety review needed: “${name}”`,
      body: `${review.kind === 'script' ? 'Script' : 'Rendered video'} flagged: ${review.reason}`,
      link: '/admin?tab=safety',
      dedupeKey: `safety_review:${review.id}`,
      // 16.5: without a project row there is no name; the stored English text is used.
      ...(project && {
        message: {
          key: 'safetyReviewStaff',
          params: {
            name: projectNameParam(project.name),
            kind: review.kind,
            reason: review.reason.slice(0, 500),
          },
        },
      }),
    });
  } catch (err) {
    host.logger.error({ err, reviewId: review.id }, 'safety review staff notification failed');
  }
  if (project) {
    await notifySafely(host, {
      organisationId: review.organisationId,
      userId: project.createdByUserId,
      kind: 'safety_review',
      title: `“${name}” is waiting for a content-safety review`,
      body: 'PostMind’s Trust & Safety team is checking it. Generation continues if it is allowed.',
      link: `/projects/${review.projectId}`,
      dedupeKey: `safety_review_opened:${review.id}`,
      message: {
        key: 'safetyReviewOpened',
        params: { name: projectNameParam(project.name) },
      },
    });
  }
}
