import type { ContentPlanItemStatus, VideoProjectState } from '@prisma/client';
import { ACTIVE_PIPELINE_STATES } from '../pipeline/project-state';

// 20.9 — a plan item's status once it has a project: read from the project (pipeline state,
// review decision, safety verdicts) and its publications / auto-publish rows. Pure, so the plan
// view and the runner agree on what "held by safety" or "scheduled" means.

/** Review / failure codes that mean content safety stopped the item (held, never published). */
const SAFETY_REVIEW_CODES = new Set(['content_safety_flag', 'script_safety_flag']);

export interface ProjectSnapshot {
  state: VideoProjectState;
  errorReason: string | null;
  /** metadata.review.code (auto-approve decision), if any. */
  reviewCode: string | null;
  /** A pending safety review (pipeline/safety-review.ts) is open. */
  safetyReviewPending: boolean;
  /** Some render failed its content-safety check. */
  contentSafetyFailed: boolean;
  publications: Array<{ state: string }>;
  /** Auto-publish rows not yet sent (PENDING / SENDING). */
  pendingOutbox: number;
}

/** Statuses the owner (or the plan) has settled; the runner never changes them again. */
export const FINAL_ITEM_STATUSES: ReadonlySet<ContentPlanItemStatus> = new Set([
  'POSTED',
  'SKIPPED',
  'REMOVED',
]);

export function isSafetyFailure(reason: string | null | undefined): boolean {
  return Boolean(reason && /^(script_safety|content_safety|safety_review)/.test(reason));
}

export function itemStatusFromProject(p: ProjectSnapshot): {
  status: ContentPlanItemStatus;
  reason: string | null;
} {
  if (p.publications.some((x) => x.state === 'PUBLISHED'))
    return { status: 'POSTED', reason: null };
  if (p.state === 'PUBLISHED' || p.state === 'PARTIALLY_PUBLISHED')
    return { status: 'POSTED', reason: null };
  if (p.safetyReviewPending) return { status: 'HELD', reason: 'safety_review' };
  if (ACTIVE_PIPELINE_STATES.includes(p.state)) return { status: 'GENERATING', reason: null };
  if (p.state === 'DRAFT') return { status: 'QUEUED', reason: null };
  if (p.state === 'READY_FOR_REVIEW') {
    if (p.contentSafetyFailed || (p.reviewCode && SAFETY_REVIEW_CODES.has(p.reviewCode)))
      return { status: 'HELD', reason: p.reviewCode ?? 'content_safety_flag' };
    return { status: 'READY', reason: p.reviewCode };
  }
  if (p.state === 'QUALITY_FAILED' || p.state === 'FAILED' || p.state === 'REJECTED') {
    if (p.contentSafetyFailed || isSafetyFailure(p.errorReason))
      return { status: 'HELD', reason: p.errorReason ?? 'content_safety' };
    return { status: 'FAILED', reason: p.errorReason ?? p.state.toLowerCase() };
  }
  if (p.state === 'APPROVED' || p.state === 'PUBLISHING') {
    const scheduled = p.publications.some(
      (x) => x.state === 'SCHEDULED' || x.state === 'PUBLISHING',
    );
    if (scheduled || p.pendingOutbox > 0) return { status: 'SCHEDULED', reason: null };
    if (p.publications.some((x) => x.state === 'FAILED'))
      return { status: 'FAILED', reason: 'publish_failed' };
    return { status: 'SCHEDULED', reason: null };
  }
  if (p.state === 'ARCHIVED') return { status: 'REMOVED', reason: 'archived' };
  return { status: 'FAILED', reason: p.state.toLowerCase() };
}

/** Plan-level counts for the summary (and the plan list). */
export function countStatuses(
  statuses: ContentPlanItemStatus[],
): Record<ContentPlanItemStatus, number> {
  const out = {
    PLANNED: 0,
    QUEUED: 0,
    GENERATING: 0,
    READY: 0,
    SCHEDULED: 0,
    POSTED: 0,
    HELD: 0,
    FAILED: 0,
    SKIPPED: 0,
    REMOVED: 0,
  } satisfies Record<ContentPlanItemStatus, number>;
  for (const s of statuses) out[s] += 1;
  return out;
}

/** Nothing left for the runner to start or wait for. */
export function isSettled(status: ContentPlanItemStatus): boolean {
  return !['PLANNED', 'QUEUED', 'GENERATING'].includes(status);
}
