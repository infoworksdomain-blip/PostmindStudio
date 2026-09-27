import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../../errors';
import type { TenantContext } from '../../tenant';
import { allowedModes, ingestItemInput, PLATFORM_ORG } from '../library/ingest';
import { buildBlueprint, styleSignature } from '../library/blueprint';
import { recommendedVideos, similarVideos } from '../library/similarity';
import { categoryTree } from '../library/taxonomy';
import type { ProviderRunDeps } from '../pipeline/provider-run';
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
    previewUrl: await deps.storage.signedUrl(s3Bucket, s3Key, PREVIEW_TTL_SEC),
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

export async function adminIngest(
  deps: { queue: JobQueue },
  input: z.infer<typeof adminIngestInput>,
) {
  const batch = input.items.length > 1;
  const queued = [];
  for (const item of input.items) {
    const runId = createHash('sha256').update(item.sourceUrl).digest('hex').slice(0, 32);
    const data = {
      organisationId: PLATFORM_ORG,
      runId,
      planTier: 'STANDARD' as const,
      batch,
      item,
    };
    const jobId = jobIds.ingestLibraryVideo(data);
    await deps.queue.add('ingest-library-video', data, { jobId });
    queued.push({ sourceUrl: item.sourceUrl, jobId });
  }
  return { queued };
}

export const adminPatchInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2_000).nullable(),
    category: z.string().trim().min(1).max(200),
    tags: z.array(z.string().trim().min(1).max(60)).max(30),
    licenseScenario: z.enum(['LICENSED', 'OWNED', 'SCRAPED']),
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
      const data = {
        scenario,
        allowedModes: allowedModes(scenario),
        ...(input.licenseExpires !== undefined && {
          licenseExpires: input.licenseExpires ? new Date(input.licenseExpires) : null,
        }),
        ...(input.licenseSource !== undefined && { licenseSource: input.licenseSource }),
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
