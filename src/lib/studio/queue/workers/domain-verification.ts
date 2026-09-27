import type { PipelineDeps } from '../../pipeline/deps';
import {
  pendingPurges,
  pollPendingVerifications,
  purgeDisputedDomain,
  systemTxtResolver,
} from '../../scan/domain-verification';
import { jobIds } from '../enqueue';
import type { BusinessJobData, RollUpJobData } from '../queues';

// BACKLOG 13.11 — DNS TXT verification poll (every 10 minutes, scripts/worker.ts) and the
// disputed-ownership purge (queued on dispute; the poll re-queues any purge still pending).

export async function pollDomainVerifications(
  data: RollUpJobData,
  deps: PipelineDeps,
): Promise<void> {
  const result = await pollPendingVerifications({
    db: deps.db,
    resolveTxt: deps.scan.resolveTxt ?? systemTxtResolver,
    now: deps.now,
  });
  for (const row of await pendingPurges(deps.db)) {
    const job: BusinessJobData = {
      organisationId: row.organisationId,
      businessId: row.businessId,
      runId: row.id,
      planTier: 'STANDARD',
    };
    await deps.queue.add('purge-disputed-domain', job, { jobId: jobIds.purgeDisputedDomain(job) });
  }
  deps.logger.info({ runId: data.runId, ...result }, 'domain verification poll');
}

/** runId = the domain_verifications row id. */
export async function purgeDisputedDomainJob(
  data: BusinessJobData,
  deps: PipelineDeps,
): Promise<void> {
  const summary = await purgeDisputedDomain(deps, data.runId);
  if (!summary) return;
  deps.audit({
    actorUserId: 'system:domain-purge',
    organisationId: data.organisationId,
    action: 'studio.domain.purge',
    resource: { type: 'domain_verification', id: data.runId },
    metadata: { businessId: data.businessId, ...summary },
  });
  deps.logger.warn(
    { organisationId: data.organisationId, businessId: data.businessId, ...summary },
    'scraped content purged after an ownership dispute',
  );
}

export async function onDomainJobFailed(
  data: RollUpJobData | BusinessJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  deps.logger.error({ runId: data.runId, reason }, 'domain verification job failed');
}
