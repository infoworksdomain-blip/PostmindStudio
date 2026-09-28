import { pendingCalendarShadowClient } from '../../core/calendar-shadow-client';
import {
  ORGANISATION_LIST_PENDING_MESSAGE,
  pendingCoreOrganisationDirectory,
} from '../../core/organisation-directory';
import { pendingUsageReporter } from '../../core/usage-reporter';
import type { PipelineDeps } from '../../pipeline/deps';
import { deriveCalendarShadows, syncCalendarShadows } from '../../services/calendar-shadows';
import { reconcileOrganisations } from '../../services/organisation-reconciliation';
import { deriveUsageEvents, flushUsageEvents } from '../../services/usage-events';
import type { RollUpJobData } from '../queues';

// BACKLOG 15.W2 / 15.W3 / 15.W4 — scheduled PostMind Core sync jobs (BullMQ job schedulers in
// scripts/worker.ts). Each one does its Studio-side work in full (derive the outbox rows / compute
// the reconciliation) and then talks to Core through a client that is "pending" until Core
// publishes the API: usage events and calendar shadows stay pending_setup, and the organisation
// reconciliation is skipped with an info log (a job that fails every day would only train on-call
// to ignore it — the 13.35 pattern).

export const USAGE_REPORT_SCHEDULE = '7 * * * *';
export const CALENDAR_SYNC_SCHEDULE = '*/5 * * * *';
export const ORGANISATION_RECONCILE_SCHEDULE = '45 3 * * *';

export async function reportUsage(_data: RollUpJobData, deps: PipelineDeps): Promise<void> {
  const derived = await deriveUsageEvents(deps.db, deps.now());
  const flush = await flushUsageEvents(deps, deps.core?.usage ?? pendingUsageReporter);
  deps.logger.info({ ...derived, ...flush }, 'usage events reported');
}

export async function syncCalendar(_data: RollUpJobData, deps: PipelineDeps): Promise<void> {
  const derived = await deriveCalendarShadows(deps.db, deps.now());
  const sync = await syncCalendarShadows(
    deps,
    deps.core?.calendar ?? pendingCalendarShadowClient,
    process.env.APP_URL?.trim() || 'https://studio.postmind.ai',
  );
  deps.logger.info({ ...derived, ...sync }, 'calendar shadows synced');
}

export async function reconcileOrganisationsJob(
  _data: RollUpJobData,
  deps: PipelineDeps,
): Promise<void> {
  const directory = deps.core?.organisations ?? pendingCoreOrganisationDirectory;
  if (!directory.ready) {
    deps.logger.info(
      { reason: ORGANISATION_LIST_PENDING_MESSAGE },
      'organisation reconciliation skipped',
    );
    return;
  }
  const report = await reconcileOrganisations(
    { db: deps.db, directory, logger: deps.logger, audit: deps.audit, now: deps.now },
    { apply: true },
  );
  deps.logger.info(
    { checked: report.checked, missing: report.missing.length, purged: report.purged.length },
    'organisation reconciliation finished',
  );
}

export async function onCoreSyncFailed(
  data: RollUpJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  // The next scheduled run tries again; outbox rows keep their state.
  deps.logger.error({ runId: data.runId, reason }, 'core sync job failed');
}
