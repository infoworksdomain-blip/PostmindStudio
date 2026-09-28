import type { PipelineDeps } from '../../pipeline/deps';
import { PoliteFetcher } from '../../scan/fetch';
import { findDueRescans, findStockRefreshTargets } from '../../scan/schedule';
import { jobIds } from '../enqueue';
import type { RollUpJobData, ScanJobData } from '../queues';

// BACKLOG 13.10 — the scheduled side of A6.6 (see scan/schedule.ts for the cadence):
//   sweep-website-rescans → rescan-website (conditional request) → scan-website when changed;
//   sweep-stock-refresh → refresh-image-library per business.

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

/**
 * Businesses whose newest domain verification is DISPUTED or PURGED (13.11): never rescanned
 * automatically (a person has to start a scan, or verify the domain again).
 */
async function disputedBusinesses(deps: PipelineDeps, organisationIds: string[]) {
  const rows = await deps.db.domainVerification.findMany({
    where: { organisationId: { in: organisationIds } },
    select: { organisationId: true, businessId: true, state: true },
    orderBy: { createdAt: 'desc' },
  });
  const newest = new Map<string, string>();
  for (const r of rows) {
    const key = `${r.organisationId}/${r.businessId}`;
    if (!newest.has(key)) newest.set(key, r.state);
  }
  return new Set(
    [...newest].filter(([, state]) => state === 'DISPUTED' || state === 'PURGED').map(([k]) => k),
  );
}

export async function sweepWebsiteRescans(data: RollUpJobData, deps: PipelineDeps): Promise<void> {
  const due = await findDueRescans(deps.db, deps.now());
  const blocked = await disputedBusinesses(deps, [...new Set(due.map((d) => d.organisationId))]);
  const day = dayOf(deps.now());
  let queued = 0;
  for (const target of due) {
    if (blocked.has(`${target.organisationId}/${target.businessId}`)) continue;
    const job: ScanJobData = {
      organisationId: target.organisationId,
      businessId: target.businessId,
      scanId: target.scanId,
      runId: day,
      planTier: target.planTier,
    };
    await deps.queue.add('rescan-website', job, { jobId: jobIds.rescanWebsite(job) });
    queued += 1;
  }
  deps.logger.info({ runId: data.runId, due: due.length, queued }, 'website rescan sweep');
}

/**
 * One scheduled rescan: skipped when a newer scan exists, and when the homepage answers the
 * conditional request with "not modified" (the check time is recorded on the scan instead).
 */
export async function rescanWebsite(data: ScanJobData, deps: PipelineDeps): Promise<void> {
  const scope = { organisationId: data.organisationId, businessId: data.businessId };
  const log = deps.logger.child({ ...scope, scanId: data.scanId });
  const newest = await deps.db.websiteScan.findFirst({
    where: scope,
    orderBy: { startedAt: 'desc' },
  });
  if (!newest || newest.id !== data.scanId || newest.state !== 'SUCCEEDED') {
    return log.info({ newest: newest?.id ?? null }, 'rescan skipped: a newer scan exists');
  }
  const fetcher = new PoliteFetcher({
    fetchImpl: deps.scan.pageFetch,
    sleep: deps.sleep,
    now: deps.now,
    random: deps.scan.random,
  });
  const check = await fetcher
    .checkUnchanged(newest.url, { etag: newest.etag, lastModified: newest.lastModified })
    .catch((err: Error) => {
      log.warn({ err: err.message }, 'conditional check failed; rescanning');
      return null;
    });
  if (check?.unchanged) {
    await deps.db.websiteScan.update({
      where: { id: newest.id },
      data: { checkedUnchangedAt: new Date(deps.now()) },
    });
    return log.info({ status: check.status }, 'rescan skipped: site unchanged');
  }
  const scan = await deps.db.websiteScan.create({
    data: {
      ...scope,
      url: newest.url,
      state: 'QUEUED',
      trigger: 'scheduled',
      planTier: data.planTier,
      // 14.4: a rescan repeats the confirmed scan of the same URL, so it carries that confirmation
      // (null for scans made before confirmations were stored: no browser-render fallback).
      ownershipConfirmedAt: newest.ownershipConfirmedAt,
      ownershipConfirmedByUserId: newest.ownershipConfirmedByUserId,
    },
  });
  const job: ScanJobData = { ...scope, scanId: scan.id, runId: scan.id, planTier: data.planTier };
  await deps.queue.add('scan-website', job, { jobId: jobIds.scanWebsite(job) });
  log.info({ newScanId: scan.id, status: check?.status ?? null }, 'scheduled rescan started');
}

export async function sweepStockRefresh(data: RollUpJobData, deps: PipelineDeps): Promise<void> {
  const targets = await findStockRefreshTargets(deps.db);
  const blocked = await disputedBusinesses(deps, [
    ...new Set(targets.map((t) => t.organisationId)),
  ]);
  const runId = `weekly-${dayOf(deps.now())}`;
  let queued = 0;
  for (const target of targets) {
    if (blocked.has(`${target.organisationId}/${target.businessId}`)) continue;
    const job = { ...target, runId };
    await deps.queue.add('refresh-image-library', job, { jobId: jobIds.refreshImageLibrary(job) });
    queued += 1;
  }
  deps.logger.info({ runId: data.runId, queued }, 'weekly stock refresh sweep');
}

export async function onSweepFailed(
  data: RollUpJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  deps.logger.error({ runId: data.runId, reason }, 'scheduled scan sweep failed');
}

export async function onRescanWebsiteFailed(
  data: ScanJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  deps.logger.error(
    { organisationId: data.organisationId, businessId: data.businessId, reason },
    'scheduled rescan failed',
  );
}
