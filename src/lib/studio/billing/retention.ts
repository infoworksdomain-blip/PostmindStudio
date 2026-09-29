import type { Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { AuditEntry } from '../../audit';
import { AuditAction } from '../../audit-sink';
import type { AuthMailer } from '../../email/auth-mailer';
import { ConfigurationError } from '../../errors';
import { purgeOrganisation, type PurgeResult } from '../services/organisation-purge';
import { ENDED_STATUSES, parseOverrides, type EntitlementOverrides } from './entitlements';
import { invalidateEntitlements } from './entitlements-reader';
import { emailOwners, STRIPE_ACTOR } from './sync';

// Phase 18 §8 open question 3 — cancelled-organisation data retention. A paid organisation whose
// subscription ended stays read-only (export and downloads keep working) for
// STUDIO_CANCELLED_RETENTION_DAYS (default 90; 0 disables the automatic purge). Then this daily
// job (cancelled-org-retention, 02:15 UTC) emails the owners (orgDeletionScheduled, through the
// AuthMailer contract) and hands the organisation to the existing purge
// (services/organisation-purge.ts: tokens wiped, work stopped, rows soft-deleted), whose own
// grace (STUDIO_PURGE_GRACE_DAYS, default 30) ends in the daily hard-delete-purged-orgs job.
//
// The clock (org_entitlements.overrides.retention.cancelledAt) is set by billing/sync.ts when the
// governing subscription ends and removed when the organisation subscribes again, so a
// re-subscribed organisation is never purged. Each organisation is emailed and purged once
// (retention.notifiedAt / purgeRequestedAt), and the subscription state is checked again right
// before the purge.

export const CANCELLED_RETENTION_SCHEDULE = '15 2 * * *';
export const DEFAULT_CANCELLED_RETENTION_DAYS = 90;
const MAX_RETENTION_DAYS = 3_650;
const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 200;

type Env = Record<string, string | undefined>;

/** STUDIO_CANCELLED_RETENTION_DAYS: whole days 0–3650; 0 = never purge automatically. */
export function cancelledRetentionDays(env: Env = process.env): number {
  const raw = env.STUDIO_CANCELLED_RETENTION_DAYS?.trim();
  if (!raw) return DEFAULT_CANCELLED_RETENTION_DAYS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 0 || days > MAX_RETENTION_DAYS)
    throw new ConfigurationError(
      `STUDIO_CANCELLED_RETENTION_DAYS must be a whole number of days from 0 to ${MAX_RETENTION_DAYS}`,
    );
  return days;
}

export interface RetentionDeps {
  db: PrismaClient;
  logger: Logger;
  audit: (entry: AuditEntry) => void;
  now: () => number;
  env?: Env;
  mailer?: AuthMailer;
  /** Defaults to purgeOrganisation (tests inject a spy). */
  purge?: (organisationId: string) => Promise<Pick<PurgeResult, 'graceUntil'>>;
}

export interface RetentionResult {
  enabled: boolean;
  due: number;
  purged: string[];
  skipped: Array<{ organisationId: string; reason: string }>;
}

/** Still cancelled right now? (A new subscription since the clock started stops the purge.) */
async function stillCancelled(db: PrismaClient, organisationId: string): Promise<boolean> {
  const subs = await db.subscription.findMany({
    where: { organisationId },
    select: { status: true },
  });
  return subs.every((s) => ENDED_STATUSES.has(s.status));
}

async function saveRetention(
  db: PrismaClient,
  organisationId: string,
  overrides: EntitlementOverrides,
  retention: NonNullable<EntitlementOverrides['retention']>,
): Promise<void> {
  await db.orgEntitlement.update({
    where: { organisationId },
    data: { overrides: { ...overrides, retention } as Prisma.InputJsonValue },
  });
}

export async function purgeCancelledOrganisations(deps: RetentionDeps): Promise<RetentionResult> {
  const days = cancelledRetentionDays(deps.env);
  const result: RetentionResult = { enabled: days > 0, due: 0, purged: [], skipped: [] };
  if (days === 0) return result;
  const now = new Date(deps.now());
  const cutoff = now.getTime() - days * DAY_MS;
  const rows = await deps.db.orgEntitlement.findMany({
    where: { everPaidAt: { not: null }, access: { not: 'full' } },
    select: { organisationId: true, overrides: true },
    take: BATCH * 5,
  });
  const purge =
    deps.purge ??
    ((organisationId: string) => purgeOrganisation({ db: deps.db, now: deps.now }, organisationId));
  for (const row of rows) {
    if (result.due >= BATCH) break;
    const overrides = parseOverrides(row.overrides);
    const retention = overrides.retention;
    if (!retention || retention.purgeRequestedAt) continue;
    const cancelledAt = Date.parse(retention.cancelledAt);
    if (Number.isNaN(cancelledAt) || cancelledAt > cutoff) continue;
    result.due += 1;
    const organisationId = row.organisationId;
    if (overrides.admin || !(await stillCancelled(deps.db, organisationId))) {
      result.skipped.push({ organisationId, reason: 'subscribed again or staff override' });
      continue;
    }
    try {
      const notifiedAt = retention.notifiedAt ?? now.toISOString();
      if (!retention.notifiedAt) {
        await emailOwners(
          deps,
          organisationId,
          'orgDeletionScheduled',
          { cancelledAt: retention.cancelledAt, retentionDays: days },
          `billing:retention:${organisationId}:${retention.cancelledAt}`,
        );
        await saveRetention(deps.db, organisationId, overrides, { ...retention, notifiedAt });
      }
      const purged = await purge(organisationId);
      await saveRetention(deps.db, organisationId, overrides, {
        ...retention,
        notifiedAt,
        purgeRequestedAt: now.toISOString(),
      });
      invalidateEntitlements(organisationId);
      deps.audit({
        actorUserId: STRIPE_ACTOR,
        organisationId,
        action: AuditAction.OrgDeleted,
        resource: { type: 'organisation', id: organisationId },
        metadata: {
          reason: 'cancelled_retention_elapsed',
          cancelledAt: retention.cancelledAt,
          retentionDays: days,
          graceUntil: purged.graceUntil,
        },
      });
      result.purged.push(organisationId);
    } catch (err) {
      deps.logger.error(
        { err, organisationId },
        'cancelled organisation purge failed; retried tomorrow',
      );
      result.skipped.push({ organisationId, reason: 'purge failed' });
    }
  }
  if (result.due > 0) deps.logger.info(result, 'cancelled organisation retention');
  return result;
}
