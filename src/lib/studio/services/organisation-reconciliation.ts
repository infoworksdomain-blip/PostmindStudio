import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { AuditEntry } from '../../audit';
import { UpstreamServiceError } from '../../errors';
import {
  ORGANISATION_EXISTS_BATCH,
  type CoreOrganisationDirectory,
} from '../core/organisation-directory';
import { purgeOrganisation, type PurgeResult } from './organisation-purge';

// BACKLOG 15.W4 — spec 7.14 nightly reconciliation: organisation ids held in studio.brand_kits,
// studio.platform_connections and studio.video_projects that no longer exist in PostMind Core
// are soft-deleted with the 30-day grace, through the same purge Core calls directly (13.22:
// tokens wiped, work stopped, scheduled posts cancelled, projects soft-deleted).
//
// Safety valve: a Core answer that would purge a large share of Studio's organisations is far
// more likely a Core bug or an empty response than a mass deletion, so the run refuses to apply
// (UpstreamServiceError, so the job fails loudly) when more than MAX_MISSING_SHARE of the checked
// organisations, and more than MIN_GUARDED, are missing.

export const MAX_MISSING_SHARE = 0.2;
export const MIN_GUARDED = 5;

export interface OrganisationReconcileReport {
  checked: number;
  missing: string[];
  purged: PurgeResult[];
  applied: boolean;
}

type Db = PrismaClient;

/** Organisation ids Studio holds data for and has not already purged. */
export async function studioOrganisationIds(db: Db): Promise<string[]> {
  const [kits, connections, projects, purged] = await Promise.all([
    db.brandKit.findMany({ distinct: ['organisationId'], select: { organisationId: true } }),
    db.platformConnection.findMany({
      distinct: ['organisationId'],
      select: { organisationId: true },
    }),
    db.videoProject.findMany({
      where: { deletedAt: null },
      distinct: ['organisationId'],
      select: { organisationId: true },
    }),
    db.organisationPurge.findMany({ select: { organisationId: true } }),
  ]);
  const done = new Set(purged.map((p) => p.organisationId));
  const ids = new Set(
    [...kits, ...connections, ...projects]
      .map((r) => r.organisationId)
      .filter((id) => !done.has(id)),
  );
  return [...ids].sort();
}

export async function reconcileOrganisations(
  deps: {
    db: Db;
    directory: CoreOrganisationDirectory;
    logger: Logger;
    audit: (entry: AuditEntry) => void;
    now: () => number;
  },
  options: { apply: boolean },
): Promise<OrganisationReconcileReport> {
  const ids = await studioOrganisationIds(deps.db);
  const existing = new Set<string>();
  for (let i = 0; i < ids.length; i += ORGANISATION_EXISTS_BATCH) {
    const batch = ids.slice(i, i + ORGANISATION_EXISTS_BATCH);
    for (const id of await deps.directory.existing(batch)) existing.add(id);
  }
  const missing = ids.filter((id) => !existing.has(id));
  const report: OrganisationReconcileReport = {
    checked: ids.length,
    missing,
    purged: [],
    applied: false,
  };
  if (!options.apply || missing.length === 0) return report;
  if (missing.length > MIN_GUARDED && missing.length > ids.length * MAX_MISSING_SHARE) {
    const message = `Core reported ${missing.length} of ${ids.length} organisations missing; refusing to purge automatically`;
    deps.logger.error({ missing: missing.length, checked: ids.length }, message);
    throw new UpstreamServiceError(message, { missing: missing.length, checked: ids.length });
  }
  for (const organisationId of missing) {
    const purge = await purgeOrganisation({ db: deps.db, now: deps.now }, organisationId);
    report.purged.push(purge);
    deps.audit({
      actorUserId: 'system:studio-reconciliation',
      organisationId,
      action: 'studio.organisation.purge',
      resource: { type: 'organisation', id: organisationId },
      metadata: { trigger: 'nightly_reconciliation', graceUntil: purge.graceUntil },
    });
  }
  report.applied = true;
  return report;
}
