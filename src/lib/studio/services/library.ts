import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ConfigurationError, NotFoundError, ValidationError } from '../../errors';
import type { TenantContext } from '../../tenant';
import {
  allowedModes,
  ingestItemInput,
  LICENSE_SCENARIOS,
  licenseSourceFor,
  PLATFORM_ORG,
  previewKey,
} from '../library/ingest';
import {
  existingRuns,
  ingestStatus,
  markQueued,
  submitDecision,
  type IngestStatusQuery,
} from '../library/ingest-runs';
import { categorySlugFilter } from '../library/category-filter';
import { buildBlueprint, effectiveAllowedModes, styleSignature } from '../library/blueprint';
import {
  createUncachedLibraryCache,
  LIBRARY_CACHE_TTL_SEC,
  LIBRARY_RECOMMENDED_TTL_SEC,
  normaliseQuery,
  type Jsonified,
  type LibraryCache,
} from '../library/cache';
import { searchLibrary } from '../library/search';
import { recommendedVideos, similarVideos } from '../library/similarity';
import { categoryTree } from '../library/taxonomy';
import { signThumbnail } from '../library/thumbnail-signing';
import type { ProviderRunDeps } from '../pipeline/provider-run';
import type { PlanTier } from '../providers/router';
import { jobIds, type JobQueue } from '../queue/enqueue';
import type { AssetStorage } from '../storage';
import { parseBusinessId } from './businesses';
import { toPlanTier } from './catalog';

// BACKLOG 9.6 / Addendum A3.9 — library endpoints for users (browse, detail, similar,
// recommended, categories, blueprint) and staff (ingest, edit, retire). A3.10: users never get
// a download of a reference video — only a thumbnail and a short-lived in-picker preview.
// 20.15: user reads go through the shared library cache (library/cache.ts); every staff write
// here bumps the catalogue version so the next read sees it.

type Db = PrismaClient;

/**
 * Addendum A11.1: "Rows without a licence status are unusable — the API rejects them from search
 * results." Every user-facing read (browse, detail, similar, recommended, blueprint) requires a
 * video_library_licenses row, matching free-text search (BACKLOG 15.D7).
 */
export const USABLE_LIBRARY_ITEM = { retiredAt: null, license: { isNot: null } } as const;
const PREVIEW_TTL_SEC = 10 * 60;

/**
 * 20.15: browser cache for GET library responses. Private (they sit behind sign-in, so no shared
 * cache may keep them) and short (a staff edit shows within a minute even in an open tab).
 */
export const LIBRARY_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'private, max-age=60',
};

/**
 * 20.15: what the user-facing library reads need. `cache` absent = every read goes to the
 * database (tests, no Redis); `now` drives the thumbnail signing window (default Date.now).
 */
export interface LibraryReadDeps {
  db: Db;
  storage: AssetStorage;
  cache?: LibraryCache;
  now?: () => number;
}

const UNCACHED = createUncachedLibraryCache();
const cacheOf = (deps: { cache?: LibraryCache }) => deps.cache ?? UNCACHED;
const nowOf = (deps: { now?: () => number }) => (deps.now ?? Date.now)();

export const listLibraryQuery = z.object({
  category: z.string().trim().max(200).optional(),
  tags: z
    .string()
    .max(500)
    .transform((s) =>
      s
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    )
    .optional(),
  durationMin: z.coerce.number().min(0).max(3_600).optional(),
  durationMax: z.coerce.number().min(0).max(3_600).optional(),
  mood: z.string().trim().max(80).optional(),
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});
type ListQuery = z.infer<typeof listLibraryQuery>;

const summary = {
  id: true,
  title: true,
  description: true,
  tags: true,
  durationSec: true,
  aspectRatio: true,
  sourcePlatform: true,
  s3Bucket: true,
  thumbnailS3Key: true,
  category: { select: { slug: true, name: true } },
  analysis: { select: { paceTag: true, moodTag: true, structurePattern: true, shotCount: true } },
  license: { select: { allowedModes: true, licenseExpires: true } },
} as const;

type SummaryRow = Prisma.VideoLibraryItemGetPayload<{ select: typeof summary }>;

/** The licence fields user reads need; cached raw, so expiry is judged per response. */
type LicenceTerms = { allowedModes: string[]; licenseExpires: Date | null } | null;

/** Modes for a cached (JSON) licence: expired licences allow nothing (effectiveAllowedModes). */
function modesNow(licence: Jsonified<LicenceTerms>, nowMs: number): string[] {
  return effectiveAllowedModes(
    licence && {
      allowedModes: licence.allowedModes,
      licenseExpires: licence.licenseExpires ? new Date(licence.licenseExpires) : null,
    },
    nowMs,
  );
}

function licenceTerms(
  license: { allowedModes: string[]; licenseExpires: Date | null } | null,
): LicenceTerms {
  return license
    ? { allowedModes: license.allowedModes, licenseExpires: license.licenseExpires }
    : null;
}

/** A summary as cached: no signed URL, raw licence terms, the storage location for signing. */
function unsigned(row: SummaryRow) {
  const { license, ...rest } = row;
  return { ...rest, licence: licenceTerms(license) };
}

/** Sign at the edge: drop the storage location, add the window-stable thumbnail URL. */
type CachedSummary = {
  s3Bucket: string;
  thumbnailS3Key: string;
  licence: Jsonified<LicenceTerms>;
};

async function signSummary<T extends CachedSummary>(storage: AssetStorage, row: T, nowMs: number) {
  const { s3Bucket, thumbnailS3Key, licence, ...rest } = row;
  return {
    ...rest,
    allowedModes: modesNow(licence, nowMs),
    thumbnailUrl: await signThumbnail(storage, s3Bucket, thumbnailS3Key, nowMs),
  };
}

function signRows<T extends CachedSummary>(deps: LibraryReadDeps, rows: T[]) {
  const nowMs = nowOf(deps);
  return Promise.all(rows.map((r) => signSummary(deps.storage, r, nowMs)));
}

/** The list cache key: tags deduplicated and sorted (hasEvery ignores their order). */
export function listCacheKey(query: ListQuery): Record<string, unknown> {
  return {
    ...query,
    mood: query.mood?.toLowerCase(),
    tags: query.tags?.length ? [...new Set(query.tags)].sort() : undefined,
  };
}

async function loadListPage(db: Db, query: ListQuery) {
  const where: Prisma.VideoLibraryItemWhereInput = {
    ...USABLE_LIBRARY_ITEM,
    ...(query.category && { category: categorySlugFilter(query.category) }),
    ...(query.tags?.length && { tags: { hasEvery: query.tags } }),
    ...((query.durationMin !== undefined || query.durationMax !== undefined) && {
      durationSec: {
        ...(query.durationMin !== undefined && { gte: query.durationMin }),
        ...(query.durationMax !== undefined && { lte: query.durationMax }),
      },
    }),
    ...(query.mood && { analysis: { moodTag: { contains: query.mood, mode: 'insensitive' } } }),
  };
  const rows = await db.videoLibraryItem.findMany({
    where,
    select: summary,
    orderBy: [{ ingestedAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
  });
  const page = rows.slice(0, query.limit);
  return {
    rows: page.map(unsigned),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function listLibraryVideos(deps: LibraryReadDeps, query: ListQuery) {
  const page = await cacheOf(deps).read('list', listCacheKey(query), LIBRARY_CACHE_TTL_SEC, () =>
    loadListPage(deps.db, query),
  );
  return { data: await signRows(deps, page.rows), nextCursor: page.nextCursor };
}

async function loadDetail(db: Db, id: string) {
  const item = await db.videoLibraryItem.findFirst({
    where: { id, ...USABLE_LIBRARY_ITEM },
    include: { analysis: true, license: true, category: { select: { slug: true, name: true } } },
  });
  if (!item) throw new NotFoundError('Library video not found');
  const { analysis, license } = item;
  // A3.10: an explicit allow-list. Users get the structure summary, never the reference's own
  // content (transcript, per-shot text, overlay timeline) nor staff / source fields. 20.15: this
  // trimmed shape is what is cached, plus the storage location (for signing, never returned)
  // and the raw licence terms (modes are judged per response, so an expiry is never stale).
  return {
    view: {
      id: item.id,
      title: item.title,
      description: item.description,
      tags: item.tags,
      durationSec: item.durationSec,
      aspectRatio: item.aspectRatio,
      sourcePlatform: item.sourcePlatform,
      ingestedAt: item.ingestedAt,
      category: item.category,
      analysis: analysis && {
        shotCount: analysis.shotCount,
        hookPattern: analysis.hookPattern,
        structurePattern: analysis.structurePattern,
        ctaPattern: analysis.ctaPattern,
        paceTag: analysis.paceTag,
        moodTag: analysis.moodTag,
      },
    },
    licence: licenceTerms(license),
    storage: { bucket: item.s3Bucket, key: item.s3Key, thumbnailKey: item.thumbnailS3Key },
  };
}

export async function getLibraryVideo(deps: LibraryReadDeps, id: string) {
  const cached = await cacheOf(deps).read('detail', { id }, LIBRARY_CACHE_TTL_SEC, () =>
    loadDetail(deps.db, id),
  );
  const nowMs = nowOf(deps);
  const { bucket, key, thumbnailKey } = cached.storage;
  return {
    ...cached.view,
    allowedModes: modesNow(cached.licence, nowMs),
    thumbnailUrl: await signThumbnail(deps.storage, bucket, thumbnailKey, nowMs),
    // Only the low-res preview rendition is ever signed for users (A3.10); it stays
    // short-lived and signed per request.
    previewUrl: await deps.storage.signedUrl(bucket, previewKey(key), PREVIEW_TTL_SEC),
    previewExpiresInSec: PREVIEW_TTL_SEC,
  };
}

/** Summaries (unsigned) for ranked hits, in hit order; retired / unlicensed rows drop out. */
async function hydrateRows(db: Db, hits: Array<{ id: string; similarity: number }>) {
  const rows = await db.videoLibraryItem.findMany({
    where: { id: { in: hits.map((h) => h.id) }, ...USABLE_LIBRARY_ITEM },
    select: summary,
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return hits.flatMap((hit) => {
    const row = byId.get(hit.id);
    return row ? [{ ...unsigned(row), similarity: hit.similarity }] : [];
  });
}

export const similarInput = z
  .object({ limit: z.number().int().min(1).max(50).default(12) })
  .strict();

export async function similarLibraryVideos(
  deps: LibraryReadDeps,
  id: string,
  input: z.infer<typeof similarInput>,
) {
  const rows = await cacheOf(deps).read(
    'similar',
    { id, limit: input.limit },
    LIBRARY_CACHE_TTL_SEC,
    async () => hydrateRows(deps.db, await similarVideos(deps.db, id, input.limit)),
  );
  return { data: await signRows(deps, rows) };
}

export const recommendedQuery = z.object({
  businessId: z.string().max(128),
  category: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

/**
 * Nearest to the business profile. 20.15: cached per (organisation, business, category, limit)
 * and catalogue version for LIBRARY_RECOMMENDED_TTL_SEC, so a repeat view makes no embedding call.
 */
export async function recommendedLibraryVideos(
  deps: LibraryReadDeps & { providers: ProviderRunDeps },
  tenant: TenantContext,
  query: z.infer<typeof recommendedQuery>,
) {
  const businessId = parseBusinessId(query.businessId);
  const rows = await cacheOf(deps).read(
    'recommended',
    {
      organisationId: tenant.organisationId,
      businessId,
      category: query.category,
      limit: query.limit,
    },
    LIBRARY_RECOMMENDED_TTL_SEC,
    async () => {
      const hits = await recommendedVideos(
        deps,
        {
          organisationId: tenant.organisationId,
          businessId,
          planTier: toPlanTier(tenant.organisation.planTier),
        },
        { limit: query.limit, categorySlug: query.category },
      );
      return hydrateRows(deps.db, hits);
    },
  );
  return { data: await signRows(deps, rows) };
}

export const searchLibraryInput = z
  .object({
    q: z.string().trim().min(1).max(200),
    categorySlug: z.string().trim().max(200).optional(),
    durationMin: z.number().min(0).max(3_600).optional(),
    durationMax: z.number().min(0).max(3_600).optional(),
    mood: z.string().trim().max(80).optional(),
    tags: z.array(z.string().trim().toLowerCase().min(1).max(60)).max(20).optional(),
    limit: z.number().int().min(1).max(50).default(24),
    cursor: z.string().max(8).nullable().optional(),
  })
  .strict();

/**
 * POST /library/search (BACKLOG 13.8): embedding + pgvector + keyword boost, offset cursor.
 * 20.15: the page is cached per (normalised query, every filter, limit, cursor) and catalogue
 * version; the query embedding separately for 30 days (a repeated query never pays again).
 */
export async function searchLibraryVideos(
  deps: LibraryReadDeps & { providers: ProviderRunDeps },
  tenant: TenantContext,
  input: z.infer<typeof searchLibraryInput>,
) {
  const q = normaliseQuery(input.q);
  const page = await cacheOf(deps).read(
    'search',
    {
      q,
      categorySlug: input.categorySlug,
      durationMin: input.durationMin,
      durationMax: input.durationMax,
      mood: input.mood?.toLowerCase(),
      tags: input.tags?.length ? [...new Set(input.tags)].sort() : undefined,
      limit: input.limit,
      cursor: input.cursor ?? null,
    },
    LIBRARY_CACHE_TTL_SEC,
    async () => {
      const found = await searchLibrary(
        { db: deps.db, providers: deps.providers, cache: cacheOf(deps) },
        {
          organisationId: tenant.organisationId,
          planTier: toPlanTier(tenant.organisation.planTier),
        },
        { ...input, q },
      );
      const scores = new Map(found.hits.map((h) => [h.id, h.score]));
      const rows = await hydrateRows(deps.db, found.hits);
      return {
        rows: rows.map((row) => ({ ...row, score: scores.get(row.id) ?? row.similarity })),
        nextCursor: found.nextCursor,
      };
    },
  );
  return { data: await signRows(deps, page.rows), nextCursor: page.nextCursor };
}

export function libraryCategories(db: Db, cache?: LibraryCache) {
  return cacheOf({ cache }).read('categories', {}, LIBRARY_CACHE_TTL_SEC, () => categoryTree(db));
}

async function loadBlueprint(db: Db, id: string) {
  const item = await db.videoLibraryItem.findFirst({
    where: { id, ...USABLE_LIBRARY_ITEM },
    include: { analysis: true, license: true },
  });
  if (!item?.analysis) throw new NotFoundError('Library video not found');
  const licence = licenceTerms(item.license);
  return {
    libraryVideoId: item.id,
    licence,
    // Built whenever the licence terms allow TEMPLATE; withheld per response once expired.
    blueprint: licence?.allowedModes.includes('TEMPLATE') ? buildBlueprint(item.analysis) : null,
    styleSignature: styleSignature(item.analysis),
  };
}

/** GET /library/blueprint/:id — what TEMPLATE mode would apply (and INSPIRE's signature). */
export async function libraryBlueprint(
  db: Db,
  id: string,
  cache?: LibraryCache,
  now: () => number = Date.now,
) {
  const cached = await cacheOf({ cache }).read('blueprint', { id }, LIBRARY_CACHE_TTL_SEC, () =>
    loadBlueprint(db, id),
  );
  const modes = modesNow(cached.licence, now());
  return {
    libraryVideoId: cached.libraryVideoId,
    allowedModes: modes,
    blueprint: modes.includes('TEMPLATE') ? cached.blueprint : null,
    styleSignature: cached.styleSignature,
  };
}

// ---------------------------------------------------------------- staff

export const adminIngestInput = z.object({ items: z.array(ingestItemInput).min(1).max(100) });

const PLAN_TIERS: readonly PlanTier[] = ['BASIC', 'STANDARD', 'PLUS', 'ENTERPRISE'];

/**
 * Plan tier corpus jobs run under (provider routing, queue priority and the platform org's cost
 * caps). STUDIO_LIBRARY_PLAN_TIER, default STANDARD; see runbooks/corpus-ingestion.md.
 */
export function libraryPlanTier(env: Record<string, string | undefined> = process.env): PlanTier {
  const raw = env.STUDIO_LIBRARY_PLAN_TIER?.trim().toUpperCase();
  if (!raw) return 'STANDARD';
  const tier = PLAN_TIERS.find((t) => t === raw);
  if (!tier)
    throw new ConfigurationError(
      `STUDIO_LIBRARY_PLAN_TIER must be one of ${PLAN_TIERS.join(', ')} (got "${raw}")`,
    );
  return tier;
}

/** Stable id of a source's ingest run (and job): the first 32 hex chars of sha256(sourceUrl). */
export function ingestRunId(sourceUrl: string): string {
  return createHash('sha256').update(sourceUrl).digest('hex').slice(0, 32);
}

export async function adminIngest(
  deps: { queue: JobQueue; db: Pick<Db, 'videoLibraryIngestRun' | 'videoLibraryItem'> },
  input: z.infer<typeof adminIngestInput>,
  env: Record<string, string | undefined> = process.env,
) {
  const planTier = libraryPlanTier(env);
  const batch = input.items.length > 1;
  const runIds = input.items.map((item) => ingestRunId(item.sourceUrl));
  const existing = await existingRuns(deps.db, runIds);
  const queued = [];
  const skipped = [];
  for (const [index, item] of input.items.entries()) {
    const runId = runIds[index] as string;
    const decision = submitDecision(existing.get(runId) ?? null);
    if (decision.action === 'skip') {
      skipped.push({
        sourceUrl: item.sourceUrl,
        runId,
        state: decision.state,
        libraryItemId: decision.libraryItemId,
      });
      continue;
    }
    const data = { organisationId: PLATFORM_ORG, runId, planTier, batch, item };
    const jobId = `${jobIds.ingestLibraryVideo(data)}${decision.jobSuffix}`;
    await markQueued(deps.db, {
      runId,
      sourceUrl: item.sourceUrl,
      sourceRef: item.sourceRef,
      language: item.language,
      item,
    });
    await deps.queue.add('ingest-library-video', data, { jobId });
    queued.push({ sourceUrl: item.sourceUrl, jobId, runId });
  }
  return { queued, skipped };
}

/** GET /admin/library/ingest/status — counts by state over a window, recent failures. */
export function adminIngestStatus(
  db: Pick<Db, 'videoLibraryIngestRun' | 'videoLibraryItem'>,
  query: IngestStatusQuery,
  now: number,
) {
  return ingestStatus(db, query, now);
}

export const adminPatchInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2_000).nullable(),
    category: z.string().trim().min(1).max(200),
    tags: z.array(z.string().trim().min(1).max(60)).max(30),
    licenseScenario: z.enum(LICENSE_SCENARIOS),
    licenseExpires: z.iso.datetime().nullable(),
    licenseSource: z.string().trim().max(500).nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

/** 20.15: `cache` gets a version bump after the write (metadata, category or licence). */
export async function adminPatchLibraryVideo(
  db: Db,
  id: string,
  input: z.infer<typeof adminPatchInput>,
  cache?: LibraryCache,
) {
  const item = await db.videoLibraryItem.findUnique({ where: { id }, include: { license: true } });
  if (!item) throw new NotFoundError('Library video not found');
  let categoryId: string | undefined;
  if (input.category) {
    const category = await db.videoLibraryCategory.findUnique({ where: { slug: input.category } });
    if (!category) throw new ValidationError('Unknown category slug');
    categoryId = category.id;
  }
  const updated = await db.$transaction(async (tx) => {
    const updated = await tx.videoLibraryItem.update({
      where: { id },
      data: {
        ...(input.title !== undefined && { title: input.title }),
        ...(input.description !== undefined && { description: input.description }),
        ...(categoryId && { categoryId }),
        ...(input.tags && { tags: [...new Set(input.tags.map((t) => t.toLowerCase()))] }),
      },
    });
    if (
      input.licenseScenario ||
      input.licenseExpires !== undefined ||
      input.licenseSource !== undefined
    ) {
      const scenario = input.licenseScenario ?? item.license?.scenario ?? 'LICENSED';
      // NOT_REQUIRED keeps an audit trail: without an explicit source, the existing one stays,
      // or the operator-decision default is recorded.
      const source =
        input.licenseSource !== undefined
          ? licenseSourceFor(scenario, input.licenseSource)
          : scenario === 'NOT_REQUIRED'
            ? licenseSourceFor(scenario, item.license?.licenseSource)
            : undefined;
      const data = {
        scenario,
        allowedModes: allowedModes(scenario),
        ...(input.licenseExpires !== undefined && {
          licenseExpires: input.licenseExpires ? new Date(input.licenseExpires) : null,
        }),
        ...(source !== undefined && { licenseSource: source }),
      };
      await tx.videoLibraryLicense.upsert({
        where: { libraryItemId: id },
        create: { libraryItemId: id, ...data },
        update: data,
      });
    }
    return updated;
  });
  const licenceChanged =
    input.licenseScenario !== undefined ||
    input.licenseExpires !== undefined ||
    input.licenseSource !== undefined;
  await cache?.bump(licenceChanged ? 'admin-licence-change' : 'admin-edit');
  return updated;
}

/** A3.8: hide from search, keep history (projects that referenced it keep working records). */
export async function retireLibraryVideo(db: Db, id: string, now: number, cache?: LibraryCache) {
  const updated = await db.videoLibraryItem.updateMany({
    where: { id, retiredAt: null },
    data: { retiredAt: new Date(now) },
  });
  if (updated.count === 0) throw new NotFoundError('Library video not found or already retired');
  await cache?.bump('retire');
}
