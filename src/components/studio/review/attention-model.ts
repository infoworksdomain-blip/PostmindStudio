import type { ProjectDetail } from '@/lib/client/types';
import { readReview, readScheduleIssue } from '../automation/automation';
import { isProjectBudgetPause } from './budget-raise';
import { needsDirection } from './directions-panel';
import { readMusic } from './music-status';
import {
  degradedActorShots,
  degradedPresenterShots,
  fallbacksOf,
  orgCapPause,
  waitingForProvider,
} from './paused-notes';
import { needsTopicConfirmation } from './restricted-topics-panel';
import { readSfx } from './sfx-status';
import { needsUgcRewrite } from './ugc-refused-panel';

// BACKLOG 25.8 — the review screen's one "Needs your attention" list. Every conditional notice
// that used to stack above the tabs is a row here; this module decides which rows apply, using
// the same predicates the panels use, so a row exists exactly when its panel would have shown.
// Pure (no React): the list component and its tests share it.

export type AttentionKey =
  | 'directions'
  | 'ugcRefused'
  | 'restrictedTopics'
  | 'failure'
  | 'budget'
  | 'autoResume'
  | 'safetyReview'
  | 'automation'
  | 'music'
  | 'sfx'
  | 'queued'
  | 'fallback'
  | 'presenterFallback'
  | 'actorFallback';

/** action: you need to do something · warning: worth a look · info: good to know. */
export type AttentionTone = 'action' | 'warning' | 'info';

export interface AttentionItem {
  key: AttentionKey;
  tone: AttentionTone;
}

const FAILED_STATES = new Set(['FAILED', 'REJECTED', 'QUALITY_FAILED']);
const TONE_ORDER: Record<AttentionTone, number> = { action: 0, warning: 1, info: 2 };

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Automatic review asked for a person, or a scheduled post could not be placed. */
export function automationNeedsAttention(project: ProjectDetail): boolean {
  const review = readReview(project.metadata);
  if (project.state === 'READY_FOR_REVIEW' && review?.decision === 'needs_review') return true;
  return (
    project.publishPolicy === 'SCHEDULED' &&
    project.state === 'APPROVED' &&
    readScheduleIssue(project.metadata) !== null
  );
}

export function attentionItems(
  project: ProjectDetail,
  options: { isCarousel?: boolean; now?: number } = {},
): AttentionItem[] {
  const now = options.now ?? Date.now();
  const checks: Array<[AttentionKey, AttentionTone, boolean]> = [
    ['directions', 'action', needsDirection(project)],
    ['ugcRefused', 'action', needsUgcRewrite(project)],
    ['restrictedTopics', 'action', needsTopicConfirmation(project)],
    ['failure', 'action', Boolean(project.errorReason) && FAILED_STATES.has(project.state)],
    ['budget', 'action', isProjectBudgetPause(project) && !options.isCarousel],
    ['autoResume', 'action', orgCapPause(project) !== null],
    ['safetyReview', 'warning', record(project.metadata?.safetyReview)?.state === 'PENDING'],
    ['automation', 'warning', automationNeedsAttention(project)],
    ['music', 'warning', readMusic(project.metadata)?.status === 'failed'],
    ['sfx', 'warning', readSfx(project.metadata)?.status === 'failed'],
    ['queued', 'info', waitingForProvider(project, now)],
    ['fallback', 'info', fallbacksOf(project.metadata).length > 0],
    ['presenterFallback', 'info', degradedPresenterShots(project.metadata).length > 0],
    ['actorFallback', 'info', degradedActorShots(project.metadata).length > 0],
  ];
  return checks
    .filter(([, , applies]) => applies)
    .map(([key, tone]) => ({ key, tone }))
    .sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]);
}
