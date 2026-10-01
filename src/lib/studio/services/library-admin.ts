import type { LicenseScenario, Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../../errors';
import { categorySlugFilter } from '../library/category-filter';
import { LICENSE_SCENARIOS, PLATFORM_ORG } from '../library/ingest';
import type { LibraryCache } from '../library/cache';
import type { PlanTier } from '../providers/router';
import { jobIds, type JobQueue } from '../queue/enqueue';
import type { AssetStorage } from '../storage';

// BACKLOG 15.D7 / Addendum A3.8 — the staff corpus surface beyond ingest/edit/retire:
//   GET  /admin/library/videos        every row, licensed or not, live or retired (A3.8 "Browse
//                                     and search all 50k entries; filter by … licence status")
//   POST /admin/library/videos/bulk   "Bulk-edit categorisation (accept auto-classification,
//                                     override, reject)"
//   POST /admin/library/reanalyse     "Re-run ingestion on selected items"
//   GET  /admin/library/licence-audit "Licence-status audit — every item must have a licence row"
//
// Bulk actions, defined against the ingestion model (ingest.ts step 7 picks the category from the
// analysis unless the curator named one; nothing records whether a person has checked it):
//   accept   — a person confirms the current category: categoryReview = ACCEPTED.
//   override — sets categoryId: categoryReview = OVERRIDDEN. Re-analysis keeps reviewed categories.
//   reject   — the item's automatic analysis is not fit for the corpus: categoryReview = REJECTED
//              and the item is retired (A3.8 "hides from search but preserves history"). There is
//              no un-retire endpoint; a rejected item is re-ingested from its source if wanted.

type Db = PrismaClient;

export const MAX_BULK_IDS = 100;
export const LICENCE_EXPIRY_WARNING_DAYS = 30;
export const MAX_AUDIT_PROBLEMS = 200;
const THUMB_TTL_SEC = 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

const idList = z
  .array(z.string().trim().min(1).max(64))
  .min(1)
  .max(MAX_BULK_IDS)
  .transform((ids) => [...new Set(ids)]);

export const REVIEW_FILTERS = ['unreviewed', 'ACCEPTED', 'OVERRIDDEN', 'REJECTED'] as const;

export const adminListQuery = z.object({
  /** `missing` = no licence row (unusable, A11.1); otherwise one A3.2 scenario. */
  licence: z.enum(['missing', ...LICENSE_SCENARIOS]).optional(),
  retired: z.enum(['true', 'false']).optional(),
  review: z.enum(REVIEW_FILTERS).optional(),
  category: z.string().trim().max(200).optional(),
  q: z.string().trim().max(200).optional(),
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type LicenceStatus = 'missing' | 'expired' | 'expiring' | 'ok';

/** Licence state of a row at `now` (A11.1 missing; expiry as enforced by blueprint.ts). */
export function licenceStatus(
  license: { licenseExpires: Date | null } | null,
  now: number,
): LicenceStatus {
  if (!license) return 'missing';
  const expires = license.licenseExpires?.getTime();
  if (expires === undefined) return 'ok';
  if (expires <= now) return 'expired';
  return expires - now <= LICENCE_EXPIRY_WARNING_DAYS * DAY_MS ? 'expiring' : 'ok';
}

const adminRow = {
  id: true,
  title: true,
  description: true,
  tags: true,
  durationSec: true,
  aspectRatio: true,
  sourcePlatform: true,
  s3Bucket: true,
  thumbnailS3Key: true,
  ingestedAt: true,
  retiredAt: true,
  reanalysedAt: true,
  categoryReview: true,
  categoryReviewedAt: true,
  category: { select: { id: true, slug: true, name: true } },
  analysis: { select: { paceTag: true, moodTag: true, structurePattern: true, shotCount: true } },
  license: {
    select: { scenario: true, allowedModes: true, licenseExpires: true, licenseSource: true },
  },
} as const;

type AdminRow = Prisma.VideoLibraryItemGetPayload<{ select: typeof adminRow }>;

function adminWhere(query: z.infer<typeof adminListQuery>): Prisma.VideoLibraryItemWhereInput {
  const review = query.review;
  return {
    ...(query.retired === 'true' && { retiredAt: { not: null } }),
    ...(query.retired === 'false' && { retiredAt: null }),
    ...(query.licence === 'missing' && { license: { is: null } }),
    ...(query.licence &&
      query.licence !== 'missing' && { license: { is: { scenario: query.licence } } }),
    ...(review === 'unreviewed' && { categoryReview: null }),
    ...(review && review !== 'unreviewed' && { categoryReview: review }),
    ...(query.category && { category: categorySlugFilter(query.category) }),
    ...(query.q && {
      OR: [
        { title: { contains: query.q, mode: 'insensitive' } },
        { id: query.q },
        { tags: { has: query.q.toLowerCase() } },
      ],
    }),
  };
}

async function presentAdmin(storage: AssetStorage, row: AdminRow, now: number) {
  const { s3Bucket, thumbnailS3Key, license, ...rest } = row;
  return {
    ...rest,
    allowedModes: license?.allowedModes ?? [],
    licence: {
      status: licenceStatus(license, now),
      scenario: license?.scenario ?? null,
      licenseExpires: license?.licenseExpires ?? null,
      licenseSource: license?.licenseSource ?? null,
    },
    thumbnailUrl: await storage.signedUrl(s3Bucket, thumbnailS3Key, THUMB_TTL_SEC),
  };
}

/** GET /admin/library/videos — staff list including unlicensed and retired rows. */
export async function adminListLibraryVideos(
  deps: { db: Db; storage: AssetStorage; now: () => number },
  query: z.infer<typeof adminListQuery>,
) {
  const rows = await deps.db.videoLibraryItem.findMany({
    where: adminWhere(query),
    select: adminRow,
    orderBy: [{ ingestedAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
  });
  const page = rows.slice(0, query.limit);
  const now = deps.now();
  return {
    data: await Promise.all(page.map((r) => presentAdmin(deps.storage, r, now))),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export const bulkInput = z
  .object({
    ids: idList,
    action: z.enum(['accept', 'override', 'reject']),
    /** override only: the new category, by id (A3.9 shape) or slug (as PATCH takes). */
    categoryId: z.string().trim().min(1).max(64).optional(),
    category: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const named = v.categoryId !== undefined || v.category !== undefined;
    if (v.categoryId !== undefined && v.category !== undefined)
      ctx.addIssue({ code: 'custom', message: 'Send categoryId or category, not both' });
    if (v.action === 'override' && !named)
      ctx.addIssue({ code: 'custom', message: 'override needs categoryId (or category slug)' });
    if (v.action !== 'override' && named)
      ctx.addIssue({ code: 'custom', message: `${v.action} does not take a category` });
  });

export type BulkResult = {
  action: 'accept' | 'override' | 'reject';
  updated: string[];
  missing: string[];
  retired: number;
  categoryId: string | null;
};

async function resolveCategory(db: Db, input: z.infer<typeof bulkInput>): Promise<string | null> {
  if (input.action !== 'override') return null;
  const category = await db.videoLibraryCategory.findFirst({
    where: input.categoryId ? { id: input.categoryId } : { slug: input.category },
    select: { id: true },
  });
  if (!category) throw new ValidationError('Unknown category');
  return category.id;
}

/** POST /admin/library/videos/bulk — accept / override / reject the categorisation of ≤100 items. */
export async function bulkReviewLibraryVideos(
  deps: { db: Db; now: () => number; libraryCache?: LibraryCache },
  input: z.infer<typeof bulkInput>,
): Promise<BulkResult> {
  const categoryId = await resolveCategory(deps.db, input);
  const found = await deps.db.videoLibraryItem.findMany({
    where: { id: { in: input.ids } },
    select: { id: true },
  });
  const ids = found.map((r) => r.id);
  const known = new Set(ids);
  const missing = input.ids.filter((id) => !known.has(id));
  if (ids.length === 0) throw new NotFoundError('None of these library videos exist');
  const now = new Date(deps.now());
  const review =
    input.action === 'accept'
      ? 'ACCEPTED'
      : input.action === 'override'
        ? 'OVERRIDDEN'
        : 'REJECTED';
  const retired = await deps.db.$transaction(async (tx) => {
    await tx.videoLibraryItem.updateMany({
      where: { id: { in: ids } },
      data: { categoryReview: review, categoryReviewedAt: now, ...(categoryId && { categoryId }) },
    });
    if (input.action !== 'reject') return 0;
    const result = await tx.videoLibraryItem.updateMany({
      where: { id: { in: ids }, retiredAt: null },
      data: { retiredAt: now },
    });
    return result.count;
  });
  // 20.15: categories (and, for reject, retirement) changed: user reads must see it now.
  await deps.libraryCache?.bump(`bulk-${input.action}`);
  return { action: input.action, updated: ids, missing, retired, categoryId };
}

export const reanalyseInput = z.object({ ids: idList }).strict();

/** POST /admin/library/reanalyse — queue re-analysis + re-embedding of stored sources. */
export async function queueReanalysis(
  deps: { db: Db; queue: JobQueue; now: () => number },
  input: z.infer<typeof reanalyseInput>,
  planTier: PlanTier,
) {
  const found = await deps.db.videoLibraryItem.findMany({
    where: { id: { in: input.ids } },
    select: { id: true },
  });
  const known = new Set(found.map((r) => r.id));
  const runId = String(deps.now());
  const queued: Array<{ id: string; jobId: string }> = [];
  for (const id of input.ids.filter((i) => known.has(i))) {
    const data = { organisationId: PLATFORM_ORG, runId, planTier, libraryItemId: id, batch: true };
    const jobId = jobIds.reanalyseLibraryVideo(data);
    await deps.queue.add('reanalyse-library-video', data, { jobId });
    queued.push({ id, jobId });
  }
  const skipped = input.ids.filter((id) => !known.has(id)).map((id) => ({ id, reason: 'unknown' }));
  return { queued, skipped };
}

export const licenceAuditQuery = z.object({
  limit: z.coerce.number().int().min(0).max(MAX_AUDIT_PROBLEMS).default(50),
});

type ProblemRow = {
  id: string;
  title: string;
  problem: LicenceStatus;
  licenseExpires: Date | null;
};

/**
 * GET /admin/library/licence-audit — live (non-retired) corpus by licence scenario, plus the
 * rows that break A11.1 (no licence row) or have an expired / soon-expiring licence.
 */
export async function licenceAudit(
  deps: { db: Db; now: () => number },
  query: z.infer<typeof licenceAuditQuery>,
) {
  const now = deps.now();
  const soon = new Date(now + LICENCE_EXPIRY_WARNING_DAYS * DAY_MS);
  const live = { retiredAt: null };
  const expiredWhere = { ...live, license: { is: { licenseExpires: { lte: new Date(now) } } } };
  const expiringWhere = {
    ...live,
    license: { is: { licenseExpires: { gt: new Date(now), lte: soon } } },
  };
  const missingWhere = { ...live, license: { is: null } };
  const pick = { id: true, title: true, license: { select: { licenseExpires: true } } } as const;
  const [byScenario, total, retired, missing, expired, expiring, rows] = await Promise.all([
    deps.db.videoLibraryLicense.groupBy({
      by: ['scenario'],
      where: { libraryItem: live },
      _count: { _all: true },
    }),
    deps.db.videoLibraryItem.count({ where: live }),
    deps.db.videoLibraryItem.count({ where: { retiredAt: { not: null } } }),
    deps.db.videoLibraryItem.count({ where: missingWhere }),
    deps.db.videoLibraryItem.count({ where: expiredWhere }),
    deps.db.videoLibraryItem.count({ where: expiringWhere }),
    query.limit > 0
      ? deps.db.videoLibraryItem.findMany({
          where: { OR: [missingWhere, expiredWhere, expiringWhere] },
          select: pick,
          orderBy: { ingestedAt: 'asc' },
          take: query.limit,
        })
      : Promise.resolve([]),
  ]);
  const scenarios = Object.fromEntries(LICENSE_SCENARIOS.map((s) => [s, 0])) as Record<
    LicenseScenario,
    number
  >;
  for (const row of byScenario) scenarios[row.scenario] = row._count._all;
  const problems: ProblemRow[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    problem: licenceStatus(r.license, now),
    licenseExpires: r.license?.licenseExpires ?? null,
  }));
  return {
    generatedAt: new Date(now).toISOString(),
    expiringWithinDays: LICENCE_EXPIRY_WARNING_DAYS,
    live: total,
    retired,
    byScenario: scenarios,
    missing,
    expired,
    expiringSoon: expiring,
    problems,
    problemsTruncated: missing + expired + expiring > problems.length,
  };
}
