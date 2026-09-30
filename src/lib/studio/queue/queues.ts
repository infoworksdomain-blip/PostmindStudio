import type { JobsOptions } from 'bullmq';
import { PLAN_CATALOGUE } from '../billing/catalogue';
import type { PlanTier } from '../providers/router';

// BACKLOG 3.2 — queue names (spec 11.1), job names, typed job payloads, and the retry policy
// (BACKLOG 3.9 / spec 11.5: 5 retries, exponential backoff 5s → 2min cap, then dead-letter).

export const QUEUES = {
  orchestration: 'studio-orchestration',
  assets: 'studio-assets',
  publish: 'studio-publish',
  scheduled: 'studio-scheduled',
  analytics: 'studio-analytics',
  /** Feature A corpus ingestion: isolated so staff batches never crowd out customer jobs. */
  library: 'studio-library',
  /** Phase 18 Track B: transactional and notification email (Resend), isolated from publishing. */
  email: 'studio-email',
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

/** Publishing is per publication; runId is the project run that produced the render (logging). */
export interface PublishJobData extends ProjectJobData {
  publicationId: string;
  /** fire-scheduled-publication only: the ISO time this job was scheduled for (13.9). */
  scheduledFor?: string;
}

/** Business-level work (Feature D) that belongs to no project. runId = the scan / refresh id. */
export interface BusinessJobData {
  organisationId: string;
  businessId: string;
  runId: string;
  planTier: PlanTier;
  projectId?: undefined;
  batch?: boolean;
}

export interface ScanJobData extends BusinessJobData {
  scanId: string;
}

export interface LibraryRefreshJobData extends BusinessJobData {
  queries?: string[];
}

/** Video library ingestion (Feature A): platform-level, no project. runId = source hash. */
export interface LibraryIngestJobData {
  organisationId: string;
  runId: string;
  planTier: PlanTier;
  projectId?: undefined;
  batch?: boolean;
  item: {
    sourceUrl: string;
    licenseScenario: 'LICENSED' | 'OWNED' | 'SCRAPED' | 'NOT_REQUIRED';
    licenseSource?: string;
    licenseExpires?: string;
    category?: string;
    tags: string[];
    title?: string;
    sourcePlatform?: string;
    sourceRef?: string;
    language?: string;
  };
}

/** 15.D7 / A3.8: re-analyse one stored corpus item (platform-level). runId = request time. */
export interface LibraryReanalyseJobData {
  organisationId: string;
  runId: string;
  planTier: PlanTier;
  libraryItemId: string;
  projectId?: undefined;
  batch?: boolean;
}

/** Analytics polling (spec 15.2): one job per poll; pollNumber keeps job ids unique. */
export interface PollAnalyticsJobData extends PublishJobData {
  pollNumber: number;
}

/** Nightly roll-ups (platform-level). runId = the UTC day being rolled up. */
/** 15.E1: one organisation's data export. runId = exportId. */
export interface ExportJobData {
  organisationId: string;
  runId: string;
  planTier: PlanTier;
  exportId: string;
  projectId?: undefined;
  batch?: boolean;
}

/** Phase 18 §2.8: send one studio.email_outbox row. runId = the outbox id. */
export interface SendEmailJobData {
  /** The email's organisation, or 'postmind-platform' for account mail with none. */
  organisationId: string;
  runId: string;
  planTier: PlanTier;
  outboxId: string;
  projectId?: undefined;
  batch?: boolean;
}

export interface RollUpJobData {
  organisationId: string;
  runId: string;
  planTier: PlanTier;
  projectId?: undefined;
  batch?: boolean;
}

/** 20.9: write a month plan's topics. runId = the draft run (plan.metadata.draftRunId). */
export interface ContentPlanJobData {
  organisationId: string;
  runId: string;
  planTier: PlanTier;
  planId: string;
  projectId?: undefined;
  batch?: boolean;
}

/** 20.9: the month-plan runner (every minute, platform-level); planId = kick one plan now. */
export interface AdvancePlansJobData extends RollUpJobData {
  planId?: string;
}

export interface JobDataMap {
  'plan-project': ProjectJobData;
  'generate-asset': GenerateAssetJobData;
  'compose-video': ProjectJobData;
  /** 15.A3: generated thumbnail candidates for a run's renders (after compose). */
  'generate-thumbnail': ProjectJobData;
  'run-quality-gate': ProjectJobData;
  'publish-video': PublishJobData;
  'fire-scheduled-publication': PublishJobData;
  'scan-website': ScanJobData;
  'populate-slideshow': ProjectJobData;
  'ingest-library-video': LibraryIngestJobData;
  /** 15.D7: re-run analysis + embedding on a stored corpus item (POST /admin/library/reanalyse). */
  'reanalyse-library-video': LibraryReanalyseJobData;
  'poll-publication-analytics': PollAnalyticsJobData;
  'roll-up-analytics': RollUpJobData;
  /** BACKLOG 13.29: nightly style-memory build (platform-level, 03:15 UTC). */
  'build-style-memory': RollUpJobData;
  'refresh-image-library': LibraryRefreshJobData;
  /** Spec 14.4 "approval required — pending > 2h": platform-level, every 15 minutes. */
  'check-pending-approvals': RollUpJobData;
  /** BACKLOG 13.20: rollover auto-resume of cost-cap paused projects (00:05 UTC daily). */
  'auto-resume-paused': RollUpJobData;
  /** BACKLOG 13.21: auto-publish outbox dispatcher (every minute). */
  'dispatch-auto-publish': RollUpJobData;
  /** BACKLOG 14.1: daily hard delete of organisations past the purge grace (01:30 UTC). */
  'hard-delete-purged-orgs': RollUpJobData;
  /** BACKLOG 14.2: daily sweep of browser uploads never completed (01:45 UTC). */
  'sweep-abandoned-uploads': RollUpJobData;
  /** BACKLOG 13.35: daily Core ↔ Studio Meta channel reconciliation (skipped until Core ships). */
  'reconcile-channels': RollUpJobData;
  /** BACKLOG 14.11: monthly Trust & Safety audit sample (platform-level, 06:00 UTC on the 1st). */
  'sample-safety-audit': RollUpJobData;
  /** BACKLOG 13.10: daily sweep for 30-day website rescans (platform-level). */
  'sweep-website-rescans': RollUpJobData;
  /** BACKLOG 13.10: one scheduled rescan (scanId = the business's last successful scan). */
  'rescan-website': ScanJobData;
  /** BACKLOG 13.10: weekly stock refresh sweep (platform-level). */
  'sweep-stock-refresh': RollUpJobData;
  /** BACKLOG 13.11: DNS TXT verification poll (platform-level, every 10 minutes). */
  'poll-domain-verifications': RollUpJobData;
  /** BACKLOG 13.11: purge scraped content after an ownership dispute (runId = verification id). */
  'purge-disputed-domain': BusinessJobData;
  /** 15.E1: build one organisation's data export (runId = exportId). */
  'export-account-data': ExportJobData;
  /** 15.E8: daily spec 7.15 retention sweep (platform-level). */
  'retention-sweep': RollUpJobData;
  /** 15.W2: derive + send Core usage events (hourly; pending_setup until Core ships). */
  'report-usage': RollUpJobData;
  /** 15.W3: derive + sync Core calendar shadow entries (every 5 min; pending_setup until Core ships). */
  'sync-calendar-shadows': RollUpJobData;
  /** 15.W4: nightly Core organisation reconciliation (skipped until Core ships). */
  'reconcile-organisations': RollUpJobData;
  /** 17.2: re-enqueue SCHEDULED publications whose publish job was lost (every 10 minutes). */
  'redrive-lost-publications': RollUpJobData;
  /** 17.3: platform account-status check (hourly; each connection once a day). */
  'check-platform-accounts': RollUpJobData;
  /** Phase 18 Track C: re-process Stripe events whose processing failed (every 10 minutes). */
  'sweep-stripe-events': RollUpJobData;
  /** Phase 18 Track C: nightly Stripe subscriptions reconcile (03:15 UTC). */
  'reconcile-subscriptions': RollUpJobData;
  /** Phase 18 Track C: purge organisations cancelled longer than the retention (02:15 UTC). */
  'cancelled-org-retention': RollUpJobData;
  /** Phase 18 §2.6: delete audit_log entries past STUDIO_AUDIT_RETENTION_DAYS (daily). */
  'audit-retention': RollUpJobData;
  /** Phase 18 §2.8: render and send one outbox email through Resend (5 retries). */
  'send-email': SendEmailJobData;
  /** Phase 18 §2.8: re-enqueue outbox rows whose job was lost; purge old rows (every 5 min). */
  'sweep-email-outbox': RollUpJobData;
  /** 20.9: Claude writes a month plan's topics (per organisation, spends provider budget). */
  'draft-content-plan': ContentPlanJobData;
  /** 20.9: start throttled month-plan items, track their status, send the summary (every minute). */
  'advance-content-plans': AdvancePlansJobData;
}

export type JobName = keyof JobDataMap;

export const JOB_QUEUE: Record<JobName, QueueName> = {
  'plan-project': QUEUES.orchestration,
  'generate-asset': QUEUES.assets,
  'compose-video': QUEUES.orchestration,
  'generate-thumbnail': QUEUES.assets,
  'run-quality-gate': QUEUES.orchestration,
  'publish-video': QUEUES.publish,
  'fire-scheduled-publication': QUEUES.scheduled,
  'scan-website': QUEUES.assets,
  'populate-slideshow': QUEUES.orchestration,
  'ingest-library-video': QUEUES.library,
  'reanalyse-library-video': QUEUES.library,
  'poll-publication-analytics': QUEUES.analytics,
  'roll-up-analytics': QUEUES.analytics,
  'build-style-memory': QUEUES.analytics,
  'refresh-image-library': QUEUES.assets,
  'check-pending-approvals': QUEUES.analytics,
  'auto-resume-paused': QUEUES.orchestration,
  'dispatch-auto-publish': QUEUES.publish,
  'hard-delete-purged-orgs': QUEUES.orchestration,
  'sweep-abandoned-uploads': QUEUES.orchestration,
  'reconcile-channels': QUEUES.analytics,
  'sample-safety-audit': QUEUES.analytics,
  'sweep-website-rescans': QUEUES.assets,
  'rescan-website': QUEUES.assets,
  'sweep-stock-refresh': QUEUES.assets,
  'poll-domain-verifications': QUEUES.assets,
  'purge-disputed-domain': QUEUES.assets,
  'export-account-data': QUEUES.analytics,
  'retention-sweep': QUEUES.analytics,
  'report-usage': QUEUES.analytics,
  'sync-calendar-shadows': QUEUES.analytics,
  'reconcile-organisations': QUEUES.analytics,
  'redrive-lost-publications': QUEUES.publish,
  'check-platform-accounts': QUEUES.analytics,
  'sweep-stripe-events': QUEUES.analytics,
  'reconcile-subscriptions': QUEUES.analytics,
  'cancelled-org-retention': QUEUES.orchestration,
  'audit-retention': QUEUES.analytics,
  'send-email': QUEUES.email,
  'sweep-email-outbox': QUEUES.email,
  'draft-content-plan': QUEUES.orchestration,
  'advance-content-plans': QUEUES.orchestration,
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
  // Phase 18 §P.1 "Queue priority": from the plan catalogue.
  return PLAN_CATALOGUE[planTier].queuePriority === 'high' ? PRIORITY.high : PRIORITY.normal;
}
