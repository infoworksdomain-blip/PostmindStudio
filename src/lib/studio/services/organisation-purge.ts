import type { PrismaClient } from '@prisma/client';
import { ValidationError } from '../../errors';
import { FLAG_ON, flagKeys } from '../system-flags';
import { graceUntilFrom, purgeGraceDays } from './organisation-hard-delete';
import { organisationIdParam } from './org-policy';
import { BYOC_CREDENTIAL_REVOKED, notifyByocKeysChanged } from './provider-credentials';

// BACKLOG 13.22 — POST /api/studio/internal/organisations/:id/purge (spec 8.x internal API:
// "Called by PostMind Core when an org is deleted; soft-deletes all Studio data with 30-day
// grace"; mirrors Engagement handover 14.13 /api/engagement/internal/organisations/:id/purge and
// 6.5 "soft-deletes its rows (or hard-deletes after 30-day grace)"). In one transaction:
//   1. every platform connection of the organisation (Meta channels Core registered and Studio's
//      own TikTok / YouTube / X / LinkedIn OAuth rows) is disconnected and its tokens WIPED —
//      tokens of a deleted organisation must not survive the grace period; likewise its BYOC
//      provider API keys (15, P1) are revoked and their key material WIPED;
//   2. the organisation's workspace kill switch is engaged, so queued and running work stops at
//      the next job start / provider call (spec 12);
//   3. scheduled publications are cancelled (nothing posts for a deleted organisation);
//   4. projects and style memory are soft-deleted (deletedAt), which hides them everywhere;
//   5. studio.organisation_purges records the request and graceUntil = now + 30 days.
// Idempotent: a repeat call re-applies steps 1–4 (catching anything created since) and keeps the
// first request's graceUntil. BACKLOG 14.1: once graceUntil passes, the daily
// hard-delete-purged-orgs job deletes the rows and S3 objects (organisation-hard-delete.ts).
// The grace is STUDIO_PURGE_GRACE_DAYS (default 30, Engagement handover 14.13).

/** The default grace; the effective value is purgeGraceDays() (STUDIO_PURGE_GRACE_DAYS). */
export const PURGE_GRACE_DAYS = 30;

export interface PurgeResult {
  organisationId: string;
  channelsWiped: number;
  projectsDeleted: number;
  publicationsCancelled: number;
  requestedAt: string;
  graceUntil: string;
  /** True when Core had already asked for this organisation's purge. */
  repeated: boolean;
}

export async function purgeOrganisation(
  deps: { db: PrismaClient; now: () => number },
  organisationId: string,
): Promise<PurgeResult> {
  const parsed = organisationIdParam.safeParse(organisationId);
  if (!parsed.success) throw new ValidationError('Invalid organisation id');
  const org = parsed.data;
  const now = new Date(deps.now());
  const graceDays = purgeGraceDays();

  const result = await deps.db.$transaction(async (tx) => {
    await tx.providerCredential.updateMany({
      where: {
        organisationId: org,
        OR: [
          { state: { not: BYOC_CREDENTIAL_REVOKED } },
          { encryptedKey: { not: null } },
          { encryptedSecondaryKey: { not: null } },
        ],
      },
      data: { state: BYOC_CREDENTIAL_REVOKED, encryptedKey: null, encryptedSecondaryKey: null },
    });
    const channels = await tx.platformConnection.updateMany({
      where: {
        organisationId: org,
        OR: [{ state: { not: 'revoked' } }, { encryptedAccessToken: { not: '' } }],
      },
      data: {
        state: 'revoked',
        encryptedAccessToken: '',
        encryptedRefreshToken: null,
        accessTokenExpiresAt: null,
      },
    });
    const key = flagKeys.workspace(org);
    await tx.systemFlag.upsert({
      where: { key },
      create: { key, value: FLAG_ON },
      update: { value: FLAG_ON },
    });
    const scheduled = await tx.videoPublication.findMany({
      where: { organisationId: org, state: 'SCHEDULED' },
      select: { id: true },
    });
    const ids = scheduled.map((p) => p.id);
    if (ids.length) {
      await tx.videoPublication.updateMany({
        where: { id: { in: ids }, state: 'SCHEDULED' },
        data: { state: 'CANCELLED', errorReason: 'organisation_deleted' },
      });
      await tx.scheduledPublication.updateMany({
        where: { publicationId: { in: ids }, state: 'PENDING' },
        data: { state: 'CANCELLED' },
      });
    }
    const projects = await tx.videoProject.updateMany({
      where: { organisationId: org, deletedAt: null },
      data: { deletedAt: now },
    });
    await tx.styleMemory.updateMany({
      where: { organisationId: org, deletedAt: null },
      data: { deletedAt: now },
    });
    const existing = await tx.organisationPurge.findUnique({ where: { organisationId: org } });
    const record = existing
      ? await tx.organisationPurge.update({
          where: { organisationId: org },
          data: {
            channelsWiped: existing.channelsWiped + channels.count,
            projectsDeleted: existing.projectsDeleted + projects.count,
            publicationsCancelled: existing.publicationsCancelled + ids.length,
            // 14.1: a purge that staff cancelled (organisation restored) starts a new grace.
            ...(existing.state === 'cancelled'
              ? {
                  state: 'soft_deleted',
                  requestedAt: now,
                  graceUntil: graceUntilFrom(now, graceDays),
                }
              : {}),
          },
        })
      : await tx.organisationPurge.create({
          data: {
            organisationId: org,
            requestedAt: now,
            graceUntil: graceUntilFrom(now, graceDays),
            channelsWiped: channels.count,
            projectsDeleted: projects.count,
            publicationsCancelled: ids.length,
            state: 'soft_deleted',
          },
        });
    return {
      organisationId: org,
      channelsWiped: channels.count,
      projectsDeleted: projects.count,
      publicationsCancelled: ids.length,
      requestedAt: record.requestedAt.toISOString(),
      graceUntil: record.graceUntil.toISOString(),
      repeated: Boolean(existing),
    };
  });
  // Drop any cached BYOC key of the organisation in this process.
  notifyByocKeysChanged(org);
  return result;
}
