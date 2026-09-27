import type { ImageLibraryItem, ImageSource, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { NotFoundError, RateLimitError, ValidationError } from '../../errors';
import type { TenantContext } from '../../tenant';
import { ingestImage, MAX_IMAGE_BYTES, type IngestOutcome } from '../images/ingest';
import {
  deleteLibraryImage,
  generateLibraryImage,
  searchLibrary,
  type LibraryDeps,
} from '../images/library';
import { jobIds, type JobQueue } from '../queue/enqueue';
import type { AssetStorage } from '../storage';
import { businessIdParam, parseBusinessId } from './businesses';
import { toPlanTier } from './catalog';

// BACKLOG 6.6 / Addendum A6.8 — image library endpoints: list, get, upload, generate, search,
// delete, refresh. Everything is scoped by organisation AND business.

const PREVIEW_URL_TTL_SEC = 60 * 60;
const SOURCE_PARAM: Record<string, ImageSource> = {
  scraped: 'SCRAPED',
  stock: 'STOCK',
  generated: 'GENERATED',
  upload: 'UPLOAD',
};

export const listImagesQuery = z.object({
  businessId: businessIdParam,
  source: z
    .string()
    .transform((s) => s.toLowerCase())
    .pipe(z.enum(['scraped', 'stock', 'generated', 'upload']))
    .optional(),
  tag: z.string().trim().min(1).max(60).optional(),
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/** Public shape: storage coordinates are replaced by a short-lived preview URL. */
async function present(storage: AssetStorage, item: ImageLibraryItem) {
  const { s3Bucket, s3Key, fingerprint, phash, ...rest } = item;
  void fingerprint;
  void phash;
  return {
    ...rest,
    hotlinked: !s3Key,
    previewUrl: s3Key
      ? await storage.signedUrl(s3Bucket, s3Key, PREVIEW_URL_TTL_SEC)
      : item.publicUrl,
  };
}

export async function listImages(
  deps: { db: PrismaClient; storage: AssetStorage },
  organisationId: string,
  query: z.infer<typeof listImagesQuery>,
) {
  const rows = await deps.db.imageLibraryItem.findMany({
    where: {
      organisationId,
      businessId: query.businessId,
      ...(query.source && { source: SOURCE_PARAM[query.source] }),
      ...(query.tag && { tags: { has: query.tag.toLowerCase() } }),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
  });
  const page = rows.slice(0, query.limit);
  return {
    data: await Promise.all(page.map((item) => present(deps.storage, item))),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function getImage(
  deps: { db: PrismaClient; storage: AssetStorage },
  organisationId: string,
  id: string,
) {
  const item = await deps.db.imageLibraryItem.findFirst({ where: { id, organisationId } });
  if (!item) throw new NotFoundError('Image not found');
  return present(deps.storage, item);
}

async function outcomeToImage(
  deps: { db: PrismaClient; storage: AssetStorage },
  organisationId: string,
  outcome: IngestOutcome,
) {
  if (outcome.status === 'skipped') {
    const reasons: Record<string, string> = {
      too_small: 'Image is too small (the long edge must be at least 500px)',
      not_image: 'File is not a supported image (JPEG, PNG, WebP, GIF or AVIF)',
      too_large: 'Image is larger than 15 MB',
      stock_match: 'Image matches a known stock photo',
      filtered: 'Image was filtered out',
    };
    throw new ValidationError(reasons[outcome.reason] ?? 'Image rejected');
  }
  return {
    duplicate: outcome.status === 'duplicate',
    image: await getImage(deps, organisationId, outcome.id),
  };
}

/** POST /image-library (multipart): fields businessId, file, tags? (comma separated). */
export async function uploadImage(deps: LibraryDeps, tenant: TenantContext, form: FormData) {
  const businessId = parseBusinessId(form.get('businessId'));
  const file = form.get('file');
  if (!(file instanceof Blob))
    throw new ValidationError('file is required (multipart field "file")');
  if (file.size > MAX_IMAGE_BYTES) throw new ValidationError('Image is larger than 15 MB');
  const tagsField = form.get('tags');
  const tags = typeof tagsField === 'string' ? tagsField.split(',') : [];
  const altField = form.get('altText');
  const outcome = await ingestImage(deps, {
    organisationId: tenant.organisationId,
    businessId,
    source: 'UPLOAD',
    sourceProvider: 'user',
    bytes: new Uint8Array(await file.arrayBuffer()),
    altText: typeof altField === 'string' ? altField.slice(0, 1_000) : null,
    tags,
    licenseNotes: `Uploaded by user ${tenant.userId}`,
  });
  return outcomeToImage(deps, tenant.organisationId, outcome);
}

export const generateImageInput = z.object({
  businessId: businessIdParam,
  prompt: z.string().trim().min(3).max(1_000),
  style: z.string().trim().max(200).optional(),
  aspectRatio: z.enum(['9:16', '16:9', '1:1', '4:5']).default('1:1'),
});

export async function generateImage(
  deps: LibraryDeps,
  tenant: TenantContext,
  input: z.infer<typeof generateImageInput>,
) {
  const outcome = await generateLibraryImage(
    deps,
    {
      organisationId: tenant.organisationId,
      businessId: input.businessId,
      planTier: toPlanTier(tenant.organisation.planTier),
    },
    input,
  );
  return outcomeToImage(deps, tenant.organisationId, outcome);
}

export const searchImagesInput = z.object({
  businessId: businessIdParam,
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(50).default(12),
});

export async function searchImages(
  deps: LibraryDeps,
  tenant: TenantContext,
  input: z.infer<typeof searchImagesInput>,
) {
  const hits = await searchLibrary(
    deps,
    {
      organisationId: tenant.organisationId,
      businessId: input.businessId,
      planTier: toPlanTier(tenant.organisation.planTier),
    },
    input.query,
    input.limit,
  );
  const items = await deps.db.imageLibraryItem.findMany({
    where: { id: { in: hits.map((h) => h.id) }, organisationId: tenant.organisationId },
  });
  const byId = new Map(items.map((i) => [i.id, i]));
  const data = [];
  for (const hit of hits) {
    const item = byId.get(hit.id);
    if (item) data.push({ ...(await present(deps.storage, item)), similarity: hit.similarity });
  }
  return { data };
}

export async function deleteImage(deps: LibraryDeps, organisationId: string, id: string) {
  await deleteLibraryImage(deps, organisationId, id);
}

export const refreshLibraryInput = z.object({
  businessId: businessIdParam,
  queries: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
});

const MAX_REFRESH_QUERIES_PER_ORG_PER_HOUR = 100;

async function orgBusinessIds(db: PrismaClient, organisationId: string): Promise<string[]> {
  const rows = await db.businessProfile.findMany({
    where: { organisationId },
    select: { businessId: true },
  });
  return rows.map((r) => r.businessId);
}

export async function requestLibraryRefresh(
  deps: { db: PrismaClient; queue: JobQueue; now: () => number },
  tenant: TenantContext,
  input: z.infer<typeof refreshLibraryInput>,
) {
  const profile = await deps.db.businessProfile.findFirst({
    where: { businessId: input.businessId, organisationId: tenant.organisationId },
    select: { imageSearchQueries: true },
  });
  if (!input.queries?.length && !profile?.imageSearchQueries.length) {
    throw new ValidationError('No search queries: scan the website first or pass queries');
  }
  // Stock quotas are shared across tenants: cap refreshes per organisation per hour.
  const recent = await deps.db.imageLibraryQuery.count({
    where: {
      businessId: { in: await orgBusinessIds(deps.db, tenant.organisationId) },
      lastRunAt: { gte: new Date(deps.now() - 60 * 60 * 1000) },
    },
  });
  if (recent >= MAX_REFRESH_QUERIES_PER_ORG_PER_HOUR)
    throw new RateLimitError('Too many image-library refreshes this hour; try again later', 900);
  // One refresh per business per minute (jobId dedupes clicks).
  const runId = String(Math.floor(deps.now() / 60_000));
  const data = {
    organisationId: tenant.organisationId,
    businessId: input.businessId,
    runId,
    planTier: toPlanTier(tenant.organisation.planTier),
    ...(input.queries?.length && { queries: input.queries }),
  };
  await deps.queue.add('refresh-image-library', data, { jobId: jobIds.refreshImageLibrary(data) });
  return { queued: true, queries: input.queries ?? profile?.imageSearchQueries ?? [] };
}
