import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, NotFoundError, RateLimitError, ValidationError } from '../../errors';
import type { TenantContext } from '../../tenant';
import type { JobQueue } from '../queue/enqueue';
import { jobIds } from '../queue/enqueue';
import { assertFetchableUrl } from '../scan/safe-fetch';
import { toPlanTier } from './catalog';

// BACKLOG 6.5 / Addendum A6.8 — scan-website, scan history, scan detail, business profile.

export const scanWebsiteInput = z.object({
  url: z.string().trim().min(1).max(2_000),
  /** A6.7: the user warrants they own or may represent the site (and its images). */
  ownershipConfirmed: z.literal(true, {
    error: 'ownershipConfirmed must be true: confirm you own or represent this website',
  }),
});

/**
 * Each scan crawls up to 21 pages, calls Claude and makes dozens of image/stock requests, and
 * business ids are unverifiable, so scans are capped per organisation (not only per business).
 */
export const MAX_ACTIVE_SCANS_PER_ORG = 3;
export const MAX_SCANS_PER_ORG_PER_DAY = 25;

async function assertScanQuota(db: PrismaClient, organisationId: string, now: number) {
  const [active, today] = await Promise.all([
    db.websiteScan.count({ where: { organisationId, state: { in: ['QUEUED', 'RUNNING'] } } }),
    db.websiteScan.count({
      where: { organisationId, startedAt: { gte: new Date(now - 24 * 60 * 60 * 1000) } },
    }),
  ]);
  if (active >= MAX_ACTIVE_SCANS_PER_ORG)
    throw new RateLimitError(`At most ${MAX_ACTIVE_SCANS_PER_ORG} scans can run at once`, 60);
  if (today >= MAX_SCANS_PER_ORG_PER_DAY)
    throw new RateLimitError(`At most ${MAX_SCANS_PER_ORG_PER_DAY} scans per 24 hours`, 3_600);
}

export async function startScan(
  deps: { db: PrismaClient; queue: JobQueue; now: () => number },
  tenant: TenantContext,
  businessId: string,
  input: z.infer<typeof scanWebsiteInput>,
) {
  // Bare domains get https://; any other explicit scheme is kept (and refused if not http/s).
  const raw = /^[a-z][a-z0-9+.-]*:/i.test(input.url) ? input.url : `https://${input.url}`;
  const url = assertFetchableUrl(raw);
  url.hash = '';
  await assertScanQuota(deps.db, tenant.organisationId, deps.now());
  const running = await deps.db.websiteScan.findFirst({
    where: {
      organisationId: tenant.organisationId,
      businessId,
      state: { in: ['QUEUED', 'RUNNING'] },
    },
    select: { id: true },
  });
  if (running)
    throw new ConflictError('A scan for this business is already in progress', {
      scanId: running.id,
    });
  const scan = await deps.db.websiteScan.create({
    data: {
      organisationId: tenant.organisationId,
      businessId,
      url: url.toString(),
      state: 'QUEUED',
      trigger: 'manual',
      // Scheduled rescans (13.10) run at the tier of the last scan a person started.
      planTier: toPlanTier(tenant.organisation.planTier),
    },
  });
  const data = {
    scanId: scan.id,
    organisationId: tenant.organisationId,
    businessId,
    runId: scan.id,
    planTier: toPlanTier(tenant.organisation.planTier),
  };
  await deps.queue.add('scan-website', data, { jobId: jobIds.scanWebsite(data) });
  return scan;
}

export function listScans(db: PrismaClient, organisationId: string, businessId: string) {
  return db.websiteScan.findMany({
    where: { organisationId, businessId },
    orderBy: { startedAt: 'desc' },
    take: 50,
  });
}

export async function getScan(db: PrismaClient, organisationId: string, id: string) {
  const scan = await db.websiteScan.findFirst({ where: { id, organisationId } });
  if (!scan) throw new NotFoundError('Scan not found');
  const images = await db.imageLibraryItem.groupBy({
    by: ['source'],
    where: { organisationId, businessId: scan.businessId },
    _count: { _all: true },
  });
  return {
    ...scan,
    errors: scan.errorReason ? scan.errorReason.split('\n') : [],
    library: Object.fromEntries(images.map((g) => [g.source, g._count._all])),
  };
}

export async function getBusinessProfile(
  db: PrismaClient,
  organisationId: string,
  businessId: string,
) {
  const profile = await db.businessProfile.findFirst({ where: { businessId, organisationId } });
  if (!profile) throw new NotFoundError('No business profile yet: run a website scan first');
  return profile;
}

const editableList = (max: number) =>
  z
    .array(z.string().trim().min(1).max(120))
    .max(max)
    .transform((items) => [...new Set(items)]);

/** A6.8: user edits of the classification. Edited profiles are not overwritten by re-scans. */
export const patchBusinessProfileInput = z
  .object({
    industry: z.string().trim().min(1).max(200),
    subNiche: z.string().trim().min(1).max(200),
    products: editableList(30),
    services: editableList(30),
    audienceKeywords: editableList(20),
    toneIndicators: editableList(10),
    regions: editableList(10),
    imageThemes: editableList(20),
    imageSearchQueries: editableList(10),
    restrictedTopics: editableList(20),
    brandVoiceSummary: z.string().trim().max(1_000).nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export async function patchBusinessProfile(
  db: PrismaClient,
  organisationId: string,
  businessId: string,
  input: z.infer<typeof patchBusinessProfileInput>,
) {
  const profile = await getBusinessProfile(db, organisationId, businessId);
  if (input.imageSearchQueries && input.imageSearchQueries.length === 0) {
    throw new ValidationError('imageSearchQueries needs at least one query');
  }
  return db.businessProfile.update({
    where: { id: profile.id },
    data: { ...input, editedByUser: true },
  });
}
