import type { JobsOptions } from 'bullmq';
import type { PlanTier } from '../providers/router';

// BACKLOG 3.2 — queue names (spec 11.1), job names, typed job payloads, and the retry policy
// (BACKLOG 3.9 / spec 11.5: 5 retries, exponential backoff 5s → 2min cap, then dead-letter).

export const QUEUES = {
  orchestration: 'studio-orchestration',
  assets: 'studio-assets',
  publish: 'studio-publish',
  scheduled: 'studio-scheduled',
  analytics: 'studio-analytics',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Every job belongs to one project run. A new "generate" starts a new runId; jobs from an
 *  older run are ignored, which makes regenerate and cancel safe. */
export interface ProjectJobData {
  projectId: string;
  organisationId: string;
  runId: string;
  planTier: PlanTier;
  /** Agency bulk generations run at low priority (spec 11.2). */
  batch?: boolean;
}

export interface GenerateAssetJobData extends ProjectJobData {
  shotId: string;
}

export interface JobDataMap {
  'plan-project': ProjectJobData;
  'generate-asset': GenerateAssetJobData;
  'compose-video': ProjectJobData;
  'run-quality-gate': ProjectJobData;
}

export type JobName = keyof JobDataMap;

export const JOB_QUEUE: Record<JobName, QueueName> = {
  'plan-project': QUEUES.orchestration,
  'generate-asset': QUEUES.assets,
  'compose-video': QUEUES.orchestration,
  'run-quality-gate': QUEUES.orchestration,
};

export const MAX_RETRIES = 5;
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_CAP_MS = 120_000;

/** Delay before retry n (1-based): 5s, 10s, 20s, 40s, 80s, capped at 2 min. */
export function retryDelayMs(attemptsMade: number): number {
  const exponent = Math.max(0, attemptsMade - 1);
  return Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_CAP_MS);
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: MAX_RETRIES + 1,
  backoff: { type: 'studio' },
  // Keep a bounded history of successes; never auto-drain failures (spec 11.5: dead-letter
  // requires operator action).
  removeOnComplete: { age: 24 * 60 * 60, count: 5_000 },
  removeOnFail: false,
};

/** BullMQ: lower number = higher priority (spec 11.2). */
export const PRIORITY = { high: 1, normal: 5, low: 10 } as const;

export function priorityFor(planTier: PlanTier, batch = false): number {
  if (batch) return PRIORITY.low;
  return planTier === 'PLUS' || planTier === 'ENTERPRISE' ? PRIORITY.high : PRIORITY.normal;
}
