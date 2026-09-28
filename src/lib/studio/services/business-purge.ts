import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ValidationError } from '../../errors';
import { FLAG_ON, flagKeys } from '../system-flags';
import { businessIdParam } from './businesses';
import { organisationIdParam } from './org-policy';
import { PURGE_GRACE_DAYS } from './organisation-purge';

// BACKLOG 15.E2 — POST /api/studio/internal/businesses/:id/purge (spec 7.14 / 16.2 "when Core
// emits … business.deleted, Studio subscribes and cascades soft-delete"; A11.7 "on business
// deletion, profile is deleted within 30 days"). Mirrors the organisation purge (13.22) one level
// down. In one transaction:
//   1. the business's projects are soft-deleted (deletedAt) and each gets the project-level kill
//      switch, so queued and running work stops at the next job start / provider call;
//   2. its scheduled publications are cancelled (nothing posts for a deleted business);
//   3. its style memories are soft-deleted and their inferred values wiped at once;
//   4. its business-scoped platform connections (Studio OAuth rows with this businessId) are
//      revoked and their tokens WIPED — tokens of a deleted business must not survive the grace;
//   5. studio.business_purges records the request with graceUntil = now + 30 days.
// Brand kits, the business profile, website scans, domain verifications and the image library have
// no soft-delete column (brand_kits.deletedAt arrives with 15.B1): they are kept untouched during
// the grace and hard-deleted with everything else by the retention sweep once graceUntil passes
// (services/retention.ts, rule business_purge). Voice profiles are not touched: deleting a clone
// must also revoke it at ElevenLabs (13.13), which the organisation purge / the owner does.
// Idempotent: a repeat call re-applies 1–4 and keeps the first request's graceUntil.

const DAY_MS = 24 * 60 * 60 * 1000;

export const businessPurgeInput = z.object({ organisationId: organisationIdParam }).strict();

export interface BusinessPurgeResult {
  organisationId: string;
  businessId: string;
  projectsDeleted: number;
  publicationsCancelled: number;
  styleMemoriesDeleted: number;
  channelsWiped: number;
  requestedAt: string;
  graceUntil: string;
  /** True when Core had already asked for this business's purge. */
  repeated: boolean;
}

export async function purgeBusiness(
  deps: { db: PrismaClient; now: () => number },
  input: { organisationId: string; businessId: string },
): Promise<BusinessPurgeResult> {
  const business = businessIdParam.safeParse(input.businessId);
  const org = organisationIdParam.safeParse(input.organisationId);
  if (!business.success || !org.success)
    throw new ValidationError('Invalid organisation or business id');
  const organisationId = org.data;
  const businessId = business.data;
  const now = new Date(deps.now());

  return deps.db.$transaction(async (tx) => {
    const projects = await tx.videoProject.findMany({
      where: { organisationId, businessId, deletedAt: null },
      select: { id: true },
    });
    const projectIds = projects.map((p) => p.id);
    if (projectIds.length) {
      await tx.videoProject.updateMany({
        where: { id: { in: projectIds } },
        data: { deletedAt: now },
      });
      await tx.systemFlag.createMany({
        data: projectIds.map((id) => ({ key: flagKeys.project(id), value: FLAG_ON })),
        skipDuplicates: true,
      });
      await tx.systemFlag.updateMany({
        where: { key: { in: projectIds.map((id) => flagKeys.project(id)) } },
        data: { value: FLAG_ON },
      });
    }
    const scheduled = await tx.videoPublication.findMany({
      where: { organisationId, state: 'SCHEDULED', project: { businessId } },
      select: { id: true },
    });
    const pubIds = scheduled.map((p) => p.id);
    if (pubIds.length) {
      await tx.videoPublication.updateMany({
        where: { id: { in: pubIds }, state: 'SCHEDULED' },
        data: { state: 'CANCELLED', errorReason: 'business_deleted' },
      });
      await tx.scheduledPublication.updateMany({
        where: { publicationId: { in: pubIds }, state: 'PENDING' },
        data: { state: 'CANCELLED' },
      });
    }
    const memories = await tx.styleMemory.updateMany({
      where: { organisationId, businessId, deletedAt: null },
      data: { deletedAt: now, value: {}, weight: 0, evidenceCount: 0, reason: 'Business deleted' },
    });
    const channels = await tx.platformConnection.updateMany({
      where: {
        organisationId,
        businessId,
        OR: [{ state: { not: 'revoked' } }, { encryptedAccessToken: { not: '' } }],
      },
      data: {
        state: 'revoked',
        encryptedAccessToken: '',
        encryptedRefreshToken: null,
        accessTokenExpiresAt: null,
      },
    });
    const existing = await tx.businessPurge.findUnique({
      where: { organisationId_businessId: { organisationId, businessId } },
    });
    const record = existing
      ? await tx.businessPurge.update({
          where: { id: existing.id },
          data: {
            projectsDeleted: existing.projectsDeleted + projectIds.length,
            publicationsCancelled: existing.publicationsCancelled + pubIds.length,
            styleMemoriesDeleted: existing.styleMemoriesDeleted + memories.count,
          },
        })
      : await tx.businessPurge.create({
          data: {
            organisationId,
            businessId,
            requestedAt: now,
            graceUntil: new Date(now.getTime() + PURGE_GRACE_DAYS * DAY_MS),
            projectsDeleted: projectIds.length,
            publicationsCancelled: pubIds.length,
            styleMemoriesDeleted: memories.count,
            state: 'soft_deleted',
          },
        });
    return {
      organisationId,
      businessId,
      projectsDeleted: projectIds.length,
      publicationsCancelled: pubIds.length,
      styleMemoriesDeleted: memories.count,
      channelsWiped: channels.count,
      requestedAt: record.requestedAt.toISOString(),
      graceUntil: record.graceUntil.toISOString(),
      repeated: Boolean(existing),
    };
  });
}
