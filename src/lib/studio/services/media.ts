import type { ImageLibraryItem, Prisma, PrismaClient, VideoProjectState } from '@prisma/client';
import { z } from 'zod';
import { ValidationError } from '../../errors';
import type { AssetStorage } from '../storage';
import { businessIdParam } from './businesses';
import { present as presentImage } from './image-library';
import { thumbnailUrlOf } from './thumbnails';

// BACKLOG 25.10 — "My media": one read-only, newest-first feed of what the organisation already
// has, without a new table.
//   video  — finished renders (quality gate PASSED or FORCE_APPROVED) of live projects, with the
//            render's thumbnail (15.A3) signed like GET /renders/:id does; playback and download
//            stay on GET /renders/:id/preview and /renders/:id/download (studio:render:download).
//   upload — READY uploaded videos (source videos and the 22.1 demo-video bank) with a signed
//            playback URL. Slide clips belong to their slideshow and brand files to brand kits.
//   image  — the image library (6.6), presented exactly as GET /image-library presents it, and only
//            while the image-library feature is on.
// Always scoped to the caller's organisation, and to one business when businessId is given.
// Paging is keyset on (createdAt, id) descending across the three tables: each source returns
// its first `limit + 1` rows after the cursor, the merge keeps the first `limit`.

export const MEDIA_TYPES = ['all', 'video', 'image', 'upload'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];
export const MEDIA_PAGE_MAX = 60;
export const UPLOAD_PREVIEW_TTL_SEC = 60 * 60;
const MEDIA_UPLOAD_KINDS = ['SOURCE_VIDEO', 'DEMO_VIDEO'] as const;
const FINISHED_QUALITY = ['PASSED', 'FORCE_APPROVED'] as const;

export const listMediaQuery = z.object({
  type: z.enum(MEDIA_TYPES).default('all'),
  businessId: businessIdParam.optional(),
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(MEDIA_PAGE_MAX).default(24),
});
export type ListMediaQuery = z.infer<typeof listMediaQuery>;

interface Cursor {
  at: Date;
  id: string;
}

export function encodeMediaCursor(cursor: { at: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ t: cursor.at.toISOString(), id: cursor.id })).toString(
    'base64url',
  );
}

export function decodeMediaCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (parsed && typeof parsed === 'object') {
      const { t, id } = parsed as { t?: unknown; id?: unknown };
      const at = typeof t === 'string' ? new Date(t) : null;
      if (at && !Number.isNaN(at.getTime()) && typeof id === 'string' && id.length > 0)
        return { at, id };
    }
  } catch {
    // fall through to the validation error
  }
  throw new ValidationError('cursor is not valid');
}

/** Rows strictly after the cursor in (createdAt desc, id desc) order. */
function after(cursor: Cursor | null) {
  return cursor
    ? { OR: [{ createdAt: { lt: cursor.at } }, { createdAt: cursor.at, id: { lt: cursor.id } }] }
    : {};
}

const ORDER = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

export interface MediaVideo {
  type: 'video';
  id: string;
  projectId: string;
  businessId: string;
  title: string | null;
  projectState: VideoProjectState;
  platform: string;
  aspectRatio: string;
  width: number | null;
  height: number | null;
  durationSec: number;
  createdAt: string;
  thumbnailUrl: string | null;
}

export interface MediaUpload {
  type: 'upload';
  id: string;
  kind: 'source_video' | 'demo_video';
  businessId: string | null;
  projectId: string | null;
  title: string;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  sizeBytes: number | null;
  createdAt: string;
  previewUrl: string;
}

export type MediaImage = { type: 'image' } & Awaited<ReturnType<typeof presentImage>>;
export type MediaItem = MediaVideo | MediaUpload | MediaImage;

export interface MediaDeps {
  db: Pick<PrismaClient, 'videoRender' | 'videoUpload' | 'imageLibraryItem'>;
  storage: AssetStorage;
  /** Where render thumbnails live (S3_BUCKET_THUMBNAILS); no bucket → no thumbnails. */
  thumbnailBucket: string | null;
  /** Whether the image library is on for this organisation (A12.4). */
  imagesEnabled: boolean;
}

interface Entry {
  at: Date;
  id: string;
  item: () => Promise<MediaItem>;
}

/** '1080x1920' → [1080, 1920]. */
function sizeOf(resolution: string): [number | null, number | null] {
  const match = /^(\d+)x(\d+)$/.exec(resolution);
  return match ? [Number(match[1]), Number(match[2])] : [null, null];
}

async function videoEntries(
  deps: MediaDeps,
  organisationId: string,
  query: ListMediaQuery,
  cursor: Cursor | null,
): Promise<Entry[]> {
  const rows = await deps.db.videoRender.findMany({
    where: {
      qualityCheckState: { in: [...FINISHED_QUALITY] },
      project: {
        organisationId,
        deletedAt: null,
        ...(query.businessId && { businessId: query.businessId }),
      },
      ...after(cursor),
    },
    orderBy: ORDER,
    take: query.limit + 1,
    select: {
      id: true,
      targetPlatform: true,
      aspectRatio: true,
      resolution: true,
      durationSec: true,
      thumbnailS3Key: true,
      createdAt: true,
      project: { select: { id: true, name: true, state: true, businessId: true } },
    },
  });
  return rows.map((r) => ({
    at: r.createdAt,
    id: r.id,
    item: async (): Promise<MediaVideo> => {
      const [width, height] = sizeOf(r.resolution);
      return {
        type: 'video',
        id: r.id,
        projectId: r.project.id,
        businessId: r.project.businessId,
        title: r.project.name,
        projectState: r.project.state,
        platform: r.targetPlatform,
        aspectRatio: r.aspectRatio,
        width,
        height,
        durationSec: r.durationSec,
        createdAt: r.createdAt.toISOString(),
        thumbnailUrl: deps.thumbnailBucket
          ? await thumbnailUrlOf({ storage: deps.storage, bucket: deps.thumbnailBucket }, r)
          : null,
      };
    },
  }));
}

async function uploadEntries(
  deps: MediaDeps,
  organisationId: string,
  query: ListMediaQuery,
  cursor: Cursor | null,
): Promise<Entry[]> {
  const rows = await deps.db.videoUpload.findMany({
    where: {
      organisationId,
      kind: { in: [...MEDIA_UPLOAD_KINDS] },
      state: 'READY',
      ...(query.businessId && { businessId: query.businessId }),
      ...after(cursor),
    },
    orderBy: ORDER,
    take: query.limit + 1,
  });
  return rows.map((u) => ({
    at: u.createdAt,
    id: u.id,
    item: async (): Promise<MediaUpload> => ({
      type: 'upload',
      id: u.id,
      kind: u.kind === 'DEMO_VIDEO' ? 'demo_video' : 'source_video',
      businessId: u.businessId,
      projectId: u.projectId,
      title: u.fileName,
      width: u.widthPx,
      height: u.heightPx,
      durationSec: u.durationSec,
      sizeBytes: u.sizeBytes === null ? null : Number(u.sizeBytes),
      createdAt: u.createdAt.toISOString(),
      previewUrl: await deps.storage.signedUrl(u.s3Bucket, u.s3Key, UPLOAD_PREVIEW_TTL_SEC),
    }),
  }));
}

async function imageEntries(
  deps: MediaDeps,
  organisationId: string,
  query: ListMediaQuery,
  cursor: Cursor | null,
): Promise<Entry[]> {
  const where: Prisma.ImageLibraryItemWhereInput = {
    organisationId,
    ...(query.businessId && { businessId: query.businessId }),
    ...after(cursor),
  };
  const rows: ImageLibraryItem[] = await deps.db.imageLibraryItem.findMany({
    where,
    orderBy: ORDER,
    take: query.limit + 1,
  });
  return rows.map((row) => ({
    at: row.createdAt,
    id: row.id,
    item: async (): Promise<MediaImage> => ({
      type: 'image',
      ...(await presentImage(deps.storage, row)),
    }),
  }));
}

function wants(query: ListMediaQuery, type: Exclude<MediaType, 'all'>): boolean {
  return query.type === 'all' || query.type === type;
}

/** GET /api/studio/media — the organisation's renders, uploads and images, newest first. */
export async function listMedia(
  deps: MediaDeps,
  organisationId: string,
  query: ListMediaQuery,
): Promise<{ data: MediaItem[]; nextCursor: string | null }> {
  const cursor = query.cursor ? decodeMediaCursor(query.cursor) : null;
  const sources = await Promise.all([
    wants(query, 'video') ? videoEntries(deps, organisationId, query, cursor) : [],
    wants(query, 'upload') ? uploadEntries(deps, organisationId, query, cursor) : [],
    wants(query, 'image') && deps.imagesEnabled
      ? imageEntries(deps, organisationId, query, cursor)
      : [],
  ]);
  const merged = sources
    .flat()
    .sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const page = merged.slice(0, query.limit);
  const last = page.at(-1);
  return {
    data: await Promise.all(page.map((entry) => entry.item())),
    nextCursor:
      merged.length > query.limit && last ? encodeMediaCursor({ at: last.at, id: last.id }) : null,
  };
}
