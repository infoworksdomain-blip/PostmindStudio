import { reportError } from '../../observability/errors';
import { getMetrics } from '../../observability/metrics';
import { UnrecoverableError } from 'bullmq';
import {
  ConfigurationError,
  CostCapPausedError,
  KillSwitchTriggeredError,
  NoProviderAvailableError,
  NotFoundError,
  NotImplementedError,
  PlatformError,
  ProviderError,
  RateDeferredError,
  StudioError,
  ValidationError,
} from '../../../errors';
import type { PipelineDeps } from '../../pipeline/deps';
import { failProject } from '../../pipeline/project-state';
import { recordCostPause } from '../../services/auto-resume';
import { featureGateFor, type Feature } from '../../services/features';
import { checkJobAccess } from '../../billing/job-access';
import { retryDelayMs, type JobDataMap, type JobName } from '../queues';
import type { InlineJobQueue } from '../enqueue';
import { checkPendingApprovals, onCheckPendingApprovalsFailed } from './check-approvals';
import { buildStyleMemoryJob, onBuildStyleMemoryFailed } from './build-style-memory';
import { autoResumePaused, onAutoResumePausedFailed } from './auto-resume';
import { dispatchAutoPublish, onDispatchAutoPublishFailed } from './dispatch-auto-publish';
import {
  hardDeletePurgedOrgs,
  onDataRetentionFailed,
  sweepAbandonedUploadsJob,
} from './data-retention';
import { onReconcileChannelsFailed, reconcileChannels } from './reconcile-channels';
import {
  onRedriveLostPublicationsFailed,
  redriveLostPublicationsJob,
} from './redrive-lost-publications';
import { checkPlatformAccountsJob, onCheckPlatformAccountsFailed } from './check-platform-accounts';
import { auditRetentionJob, onAuditRetentionFailed } from './audit-retention';
import {
  cancelledOrgRetentionJob,
  onBillingSyncFailed,
  reconcileSubscriptionsJob,
  sweepStripeEventsJob,
} from './billing-sync';
import {
  onCoreSyncFailed,
  reconcileOrganisationsJob,
  reportUsage,
  syncCalendar,
} from './core-sync';
import { exportAccountData, onExportAccountDataFailed } from './export-account-data';
import { onRetentionSweepFailed, retentionSweep } from './retention-sweep';
import { onSampleSafetyAuditFailed, sampleSafetyAuditJob } from './sample-safety-audit';
import { composeVideo, onComposeVideoFailed } from './compose-video';
import { generateThumbnails, onGenerateThumbnailsFailed } from './generate-thumbnail';
import { generateAsset, onGenerateAssetFailed } from './generate-asset';
import { onPlanProjectFailed, planProject } from './plan-project';
import {
  fireScheduledPublication,
  onFireScheduledFailed,
  onPublishVideoFailed,
  publishVideo,
} from './publish-video';
import { ingestLibraryVideoJob, onIngestLibraryVideoFailed } from './ingest-library-video';
import { onReanalyseLibraryVideoFailed, reanalyseLibraryVideoJob } from './reanalyse-library-video';
import {
  onPollPublicationAnalyticsFailed,
  onRollUpAnalyticsFailed,
  pollPublicationAnalytics,
  rollUpAnalyticsJob,
} from './poll-analytics';
import { onPopulateSlideshowFailed, populateSlideshowJob } from './populate-slideshow';
import { onRunQualityGateFailed, runQualityGate } from './run-quality-gate';
import {
  onRefreshImageLibraryFailed,
  onScanWebsiteFailed,
  refreshImageLibrary,
  scanWebsite,
} from './scan-website';
import {
  onDomainJobFailed,
  pollDomainVerifications,
  purgeDisputedDomainJob,
} from './domain-verification';
import {
  onRescanWebsiteFailed,
  onSweepFailed,
  rescanWebsite,
  sweepStockRefresh,
  sweepWebsiteRescans,
} from './scheduled-rescans';

// BACKLOG 3.8 / 3.9 — the wrapper every job runs through, on BullMQ or inline:
//   - kill switch checked on job start (global / workspace / project)
//   - errors classified: retryable ones retry (5 retries, 5s → 2min backoff); non-retryable
//     ones become UnrecoverableError so BullMQ doesn't waste retries
//   - on the final failed attempt the step's failure handler marks the shot/project FAILED
//   - failed jobs stay in BullMQ's failed set (dead-letter) for operator action

type JobAccessData = { organisationId: string; publicationId?: string };

type Processor<N extends JobName> = (data: JobDataMap[N], deps: PipelineDeps) => Promise<void>;
type FailureHandler<N extends JobName> = (
  data: JobDataMap[N],
  deps: PipelineDeps,
  reason: string,
  err?: unknown,
) => Promise<void>;

export const PROCESSORS: { [N in JobName]: Processor<N> } = {
  'plan-project': planProject,
  'generate-asset': generateAsset,
  'compose-video': composeVideo,
  'generate-thumbnail': generateThumbnails,
  'run-quality-gate': runQualityGate,
  'publish-video': publishVideo,
  'fire-scheduled-publication': fireScheduledPublication,
  'scan-website': scanWebsite,
  'populate-slideshow': populateSlideshowJob,
  'ingest-library-video': ingestLibraryVideoJob,
  'reanalyse-library-video': reanalyseLibraryVideoJob,
  'poll-publication-analytics': pollPublicationAnalytics,
  'roll-up-analytics': rollUpAnalyticsJob,
  'build-style-memory': buildStyleMemoryJob,
  'refresh-image-library': refreshImageLibrary,
  'check-pending-approvals': checkPendingApprovals,
  'auto-resume-paused': autoResumePaused,
  'dispatch-auto-publish': dispatchAutoPublish,
  'hard-delete-purged-orgs': hardDeletePurgedOrgs,
  'sweep-abandoned-uploads': sweepAbandonedUploadsJob,
  'reconcile-channels': reconcileChannels,
  'sample-safety-audit': sampleSafetyAuditJob,
  'sweep-website-rescans': sweepWebsiteRescans,
  'rescan-website': rescanWebsite,
  'sweep-stock-refresh': sweepStockRefresh,
  'poll-domain-verifications': pollDomainVerifications,
  'purge-disputed-domain': purgeDisputedDomainJob,
  'export-account-data': exportAccountData,
  'retention-sweep': retentionSweep,
  'report-usage': reportUsage,
  'sync-calendar-shadows': syncCalendar,
  'reconcile-organisations': reconcileOrganisationsJob,
  'redrive-lost-publications': redriveLostPublicationsJob,
  'check-platform-accounts': checkPlatformAccountsJob,
  'sweep-stripe-events': sweepStripeEventsJob,
  'reconcile-subscriptions': reconcileSubscriptionsJob,
  'cancelled-org-retention': cancelledOrgRetentionJob,
  'audit-retention': auditRetentionJob,
};

export const FAILURE_HANDLERS: { [N in JobName]: FailureHandler<N> } = {
  'plan-project': onPlanProjectFailed,
  'generate-asset': onGenerateAssetFailed,
  'compose-video': onComposeVideoFailed,
  'generate-thumbnail': onGenerateThumbnailsFailed,
  'run-quality-gate': onRunQualityGateFailed,
  'publish-video': onPublishVideoFailed,
  'fire-scheduled-publication': onFireScheduledFailed,
  'scan-website': onScanWebsiteFailed,
  'populate-slideshow': onPopulateSlideshowFailed,
  'ingest-library-video': onIngestLibraryVideoFailed,
  'reanalyse-library-video': onReanalyseLibraryVideoFailed,
  'poll-publication-analytics': onPollPublicationAnalyticsFailed,
  'roll-up-analytics': onRollUpAnalyticsFailed,
  'build-style-memory': onBuildStyleMemoryFailed,
  'refresh-image-library': onRefreshImageLibraryFailed,
  'check-pending-approvals': onCheckPendingApprovalsFailed,
  'auto-resume-paused': onAutoResumePausedFailed,
  'dispatch-auto-publish': onDispatchAutoPublishFailed,
  'hard-delete-purged-orgs': onDataRetentionFailed,
  'sweep-abandoned-uploads': onDataRetentionFailed,
  'reconcile-channels': onReconcileChannelsFailed,
  'sample-safety-audit': onSampleSafetyAuditFailed,
  'sweep-website-rescans': onSweepFailed,
  'rescan-website': onRescanWebsiteFailed,
  'sweep-stock-refresh': onSweepFailed,
  'poll-domain-verifications': onDomainJobFailed,
  'purge-disputed-domain': onDomainJobFailed,
  'export-account-data': onExportAccountDataFailed,
  'retention-sweep': onRetentionSweepFailed,
  'report-usage': onCoreSyncFailed,
  'sync-calendar-shadows': onCoreSyncFailed,
  'reconcile-organisations': onCoreSyncFailed,
  'redrive-lost-publications': onRedriveLostPublicationsFailed,
  'check-platform-accounts': onCheckPlatformAccountsFailed,
  'sweep-stripe-events': onBillingSyncFailed,
  'reconcile-subscriptions': onBillingSyncFailed,
  'cancelled-org-retention': onBillingSyncFailed,
  'audit-retention': onAuditRetentionFailed,
};

/**
 * 15.D1 / A12.4: jobs that belong to a switchable feature stop (403 feature_disabled, not retried)
 * while the feature is off for their organisation. Library ingestion is staff curation and stays
 * on; generate-asset's image-library lookups follow the project, which was gated at creation.
 */
export const JOB_FEATURES: Partial<Record<JobName, Feature>> = {
  'populate-slideshow': 'slideshow',
  'refresh-image-library': 'image-library',
};

export function isRetryable(err: unknown): boolean {
  if (err instanceof ProviderError || err instanceof PlatformError) return err.retryable;
  // Breakers close and budgets reset; routing again later may succeed.
  if (err instanceof NoProviderAvailableError) return true;
  if (
    err instanceof KillSwitchTriggeredError ||
    err instanceof ValidationError ||
    err instanceof NotFoundError ||
    err instanceof NotImplementedError ||
    err instanceof ConfigurationError
  ) {
    return false;
  }
  if (err instanceof StudioError) return false;
  return true; // unexpected errors (DB blips, network) are worth retrying
}

export function describeError(err: unknown): string {
  if (err instanceof KillSwitchTriggeredError) return `kill_switch_${err.level}: ${err.message}`;
  if (err instanceof CostCapPausedError) return `cost_cap_paused: ${err.message}`;
  if (err instanceof ProviderError) return `${err.providerId}/${err.errorClass}: ${err.message}`;
  if (err instanceof PlatformError) return `${err.platform}/${err.errorClass}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

export interface JobAttempt {
  /** Attempts already made before this one (BullMQ job.attemptsMade). */
  attemptsMade: number;
  maxAttempts: number;
}

export async function executeJob<N extends JobName>(
  name: N,
  data: JobDataMap[N],
  deps: PipelineDeps,
  attempt: JobAttempt,
): Promise<void> {
  const log = deps.logger.child({
    job: name,
    projectId: data.projectId,
    organisationId: data.organisationId,
    runId: data.runId,
  });
  const started = performance.now();
  const metrics = getMetrics();
  const record = (outcome: 'succeeded' | 'retrying' | 'failed') => {
    metrics.jobs.inc({ job: name, outcome });
    metrics.jobDuration.observe({ job: name, outcome }, (performance.now() - started) / 1000);
  };
  try {
    await deps.killSwitch.assertNotKilled({
      organisationId: data.organisationId,
      projectId: data.projectId,
    });
    // Phase 18 §P.3: billing access at job start — spend jobs stop (402), publish jobs are held.
    if ((await checkJobAccess(deps, name, data as JobAccessData)) === 'held') {
      record('succeeded');
      return;
    }
    const feature = JOB_FEATURES[name];
    if (feature)
      await (deps.features ?? featureGateFor(deps.db)).assertEnabled(feature, data.organisationId);
    await PROCESSORS[name](data, deps);
    record('succeeded');
  } catch (err) {
    // 15.C3: a full provider rate window is not a failure; the caller delays the job without
    // spending an attempt (worker-host.ts moveToDelayed, drainInline sleeps).
    if (err instanceof RateDeferredError) {
      log.info({ providerId: err.providerId, retryAfterMs: err.retryAfterMs }, 'job deferred');
      throw err;
    }
    const retryable = isRetryable(err);
    const final = !retryable || attempt.attemptsMade + 1 >= attempt.maxAttempts;
    record(final ? 'failed' : 'retrying');
    log.warn({ err, retryable, final, attempt: attempt.attemptsMade + 1 }, 'job attempt failed');
    if (final) {
      reportError(err, { job: name, projectId: data.projectId, runId: data.runId });
      // Spec 12.5 pause: the project fails as cost_cap_paused (not as a step failure) so the UI
      // and the user see why; raising the cap and regenerating continues it.
      if (err instanceof CostCapPausedError && data.projectId) {
        await failProject(deps.db, {
          projectId: data.projectId,
          runId: data.runId,
          reason: describeError(err),
        })
          // 13.20: which cap and stage paused the run, for the rollover auto-resume.
          .then(() => recordCostPause(deps, data, name, err))
          .catch((pauseErr: unknown) =>
            log.error({ err: pauseErr }, 'could not record the cost-cap pause'),
          );
      }
      try {
        await FAILURE_HANDLERS[name](data, deps, describeError(err), err);
      } catch (handlerErr) {
        log.error({ err: handlerErr }, 'failure handler itself failed');
      }
      if (!retryable) throw new UnrecoverableError(describeError(err));
    }
    throw err;
  }
}

/**
 * Run every queued job to completion in-process, honouring the same retry policy (with the
 * injected sleep). Used by integration tests and scripts/run-test-project.ts (GATE 3).
 */
export async function drainInline(
  queue: InlineJobQueue,
  deps: PipelineDeps,
  options: { maxAttempts?: number } = {},
): Promise<{ executed: number; failedJobs: string[] }> {
  const maxAttempts = options.maxAttempts ?? 6;
  let executed = 0;
  const failedJobs: string[] = [];
  for (let job = queue.take(); job; job = queue.take()) {
    for (let attemptsMade = 0; ; attemptsMade += 1) {
      executed += 1;
      try {
        await executeJob(job.name, job.data as never, deps, { attemptsMade, maxAttempts });
        break;
      } catch (err) {
        // 15.C3: wait out the rate window; the deferral does not count as an attempt.
        if (err instanceof RateDeferredError) {
          attemptsMade -= 1;
          await deps.sleep(err.retryAfterMs);
          continue;
        }
        if (err instanceof UnrecoverableError || attemptsMade + 1 >= maxAttempts) {
          failedJobs.push(job.jobId ?? job.name);
          // Dead-letter it, as BullMQ keeps it in the failed set (15.D4 admin view).
          queue.fail(job, describeError(err), attemptsMade + 1);
          break;
        }
        await deps.sleep(retryDelayMs(attemptsMade + 1));
      }
    }
  }
  return { executed, failedJobs };
}
