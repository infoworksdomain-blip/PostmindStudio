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
import { buildBlueprint, styleSignature } from '../library/blueprint';
import { searchLibrary } from '../library/search';
import { recommendedVideos, similarVideos } from '../library/similarity';
import { categoryTree } from '../library/taxonomy';
import type { ProviderRunDeps } from '../pipeline/provider-run';
import type { PlanTier } from '../providers/router';
import { jobIds, type JobQueue } from '../queue/enqueue';
import type { AssetStorage } from '../storage';
import { parseBusinessId } from './businesses';
import { toPlanTier } from './catalog';

// BACKLOG 9.6 / Addendum A3.9 — library endpoints for users (browse, detail, similar,
// recommended, categories, blueprint) and staff (ingest, edit, retire). A3.10: users never get
// a download of a reference video — only a thumbnail and a short-lived in-picker preview.

type Db = PrismaClient;
const THUMB_TTL_SEC = 60 * 60;
const PREVIEW_TTL_SEC = 10 * 60;

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
  license: { select: { allowedModes: true } },
} as const;

type SummaryRow = Prisma.VideoLibraryItemGetPayload<{ select: typeof summary }>;

async function present(storage: AssetStorage, row: SummaryRow) {
  const { s3Bucket, thumbnailS3Key, license, ...rest } = row;
  return {
    ...rest,
    allowedModes: license?.allowedModes ?? [],
    thumbnailUrl: await storage.signedUrl(s3Bucket, thumbnailS3Key, THUMB_TTL_SEC),
  };
}

export async function listLibraryVideos(
  deps: { db: Db; storage: AssetStorage },
  query: z.infer<typeof listLibraryQuery>,
) {
  const where: Prisma.VideoLibraryItemWhereInput = {
    retiredAt: null,
    ...(query.category && { category: { slug: { startsWith: query.category } } }),
    ...(query.tags?.length && { tags: { hasEvery: query.tags } }),
    ...((query.durationMin !== undefined || query.durationMax !== undefined) && {
      durationSec: {
        ...(query.durationMin !== undefined && { gte: query.durationMin }),
        ...(query.durationMax !== undefined && { lte: query.durationMax }),
      },
    }),
    ...(query.mood && { analysis: { moodTag: { contains: query.mood, mode: 'insensitive' } } }),
  };
  const rows = await deps.db.videoLibraryItem.findMany({
    where,
    select: summary,
    orderBy: [{ ingestedAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
  });
  const page = rows.slice(0, query.limit);
  return {
    data: await Promise.all(page.map((r) => present(deps.storage, r))),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function getLibraryVideo(deps: { db: Db; storage: AssetStorage }, id: string) {
  const item = await deps.db.videoLibraryItem.findFirst({
    where: { id, retiredAt: null },
    include: { analysis: true, license: true, category: { select: { slug: true, name: true } } },
  });
  if (!item) throw new NotFoundError('Library video not found');
  const { s3Bucket, s3Key, thumbnailS3Key, license, sourceUrl, ...rest } = item;
  void sourceUrl; // attribution stays internal (A3.10)
  return {
    ...rest,
    allowedModes: license?.allowedModes ?? [],
    thumbnailUrl: await deps.storage.signedUrl(s3Bucket, thumbnailS3Key, THUMB_TTL_SEC),
    // Only the low-res muted preview rendition is ever signed for users (A3.10).
    previewUrl: await deps.storage.signedUrl(s3Bucket, previewKey(s3Key), PREVIEW_TTL_SEC),
    previewExpiresInSec: PREVIEW_TTL_SEC,
  };
}

async function hydrate(
  deps: { db: Db; storage: AssetStorage },
  hits: Array<{ id: string; similarity: number }>,
) {
  const rows = await deps.db.videoLibraryItem.findMany({
    where: { id: { in: hits.map((h) => h.id) }, retiredAt: null },
    select: summary,
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = [];
  for (const hit of hits) {
    const row = byId.get(hit.id);
    if (row) out.push({ ...(await present(deps.storage, row)), similarity: hit.similarity });
  }
  return out;
}

export const similarInput = z
  .object({ limit: z.number().int().min(1).max(50).default(12) })
  .strict();

export async function similarLibraryVideos(
  deps: { db: Db; storage: AssetStorage },
  id: string,
  input: z.infer<typeof similarInput>,
) {
  return { data: await hydrate(deps, await similarVideos(deps.db, id, input.limit)) };
}

export const recommendedQuery = z.object({
  businessId: z.string().max(128),
  category: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

export async function recommendedLibraryVideos(
  deps: { db: Db; storage: AssetStorage; providers: ProviderRunDeps },
  tenant: TenantContext,
  query: z.infer<typeof recommendedQuery>,
) {
  const hits = await recommendedVideos(
    deps,
    {
      organisationId: tenant.organisationId,
      businessId: parseBusinessId(query.businessId),
      planTier: toPlanTier(tenant.organisation.planTier),
    },
    { limit: query.limit, categorySlug: query.category },
  );
  return { data: await hydrate(deps, hits) };
}

export const searchLibraryInput = z
  .object({
    q: z.string().trim().min(1).max(200),
    categorySlug: z.string().trim().max(200).optional(),
    limit: z.number().int().min(1).max(50).default(24),
    cursor: z.string().max(8).nullable().optional(),
  })
  .strict();

/** POST /library/search (BACKLOG 13.8): embedding + pgvector + keyword boost, offset cursor. */
export async function searchLibraryVideos(
  deps: { db: Db; storage: AssetStorage; providers: ProviderRunDeps },
  tenant: TenantContext,
  input: z.infer<typeof searchLibraryInput>,
) {
  const page = await searchLibrary(
    deps,
    {
      organisationId: tenant.organisationId,
      planTier: toPlanTier(tenant.organisation.planTier),
    },
    input,
  );
  const items = await hydrate(deps, page.hits);
  const scores = new Map(page.hits.map((h) => [h.id, h.score]));
  return {
    data: items.map((item) => ({ ...item, score: scores.get(item.id) ?? item.similarity })),
    nextCursor: page.nextCursor,
  };
}

export function libraryCategories(db: Db) {
  return categoryTree(db);
}

/** GET /library/blueprint/:id — what TEMPLATE mode would apply (and INSPIRE's signature). */
export async function libraryBlueprint(db: Db, id: string) {
  const item = await db.videoLibraryItem.findFirst({
    where: { id, retiredAt: null },
    include: { analysis: true, license: true },
  });
  if (!item?.analysis) throw new NotFoundError('Library video not found');
  const modes = item.license?.allowedModes ?? [];
  return {
    libraryVideoId: item.id,
    allowedModes: modes,
    blueprint: modes.includes('TEMPLATE') ? buildBlueprint(item.analysis) : null,
    styleSignature: styleSignature(item.analysis),
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

export async function adminPatchLibraryVideo(
  db: Db,
  id: string,
  input: z.infer<typeof adminPatchInput>,
) {
  const item = await db.videoLibraryItem.findUnique({ where: { id }, include: { license: true } });
  if (!item) throw new NotFoundError('Library video not found');
  let categoryId: string | undefined;
  if (input.category) {
    const category = await db.videoLibraryCategory.findUnique({ where: { slug: input.category } });
    if (!category) throw new ValidationError('Unknown category slug');
    categoryId = category.id;
  }
  return db.$transaction(async (tx) => {
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
}

/** A3.8: hide from search, keep history (projects that referenced it keep working records). */
export async function retireLibraryVideo(db: Db, id: string, now: number) {
  const updated = await db.videoLibraryItem.updateMany({
    where: { id, retiredAt: null },
    data: { retiredAt: new Date(now) },
  });
  if (updated.count === 0) throw new NotFoundError('Library video not found or already retired');
}
