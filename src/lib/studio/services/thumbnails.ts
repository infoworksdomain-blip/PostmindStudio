import type { PrismaClient, VideoRender } from '@prisma/client';
import { z } from 'zod';
import {
  ConfigurationError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from '../../errors';
import { hostedFontFileName } from '../fonts-host';
import type { AssetStorage } from '../storage';
import {
  createFfmpegThumbnailComposer,
  thumbnailSize,
  type ThumbnailComposer,
} from './thumbnail-composer';

// 15.A3 — render thumbnails (spec 14.2 "Each variant has its own caption, hashtags, thumbnail —
// all editable inline"; A6.5 "a thumbnail candidate from a keyframe + text overlay; the
// background image is chosen from the library, weighted toward the highest-engagement past
// images"; 9.4 step 5 thumbnails.set). Files live in the thumbnails bucket (S3_BUCKET_THUMBNAILS)
// and video_renders.thumbnailS3Key points at the current one.
//
// "Highest-engagement past images" (DERIVED): an image's engagement is the latest total views of
// every publication whose project used it on a slide (image_library ids on slideshow_slides);
// ties and images never published fall back to how often they were used (useCount).

export const THUMBNAIL_MAX_BYTES = 8 * 1024 * 1024;
export const THUMBNAIL_URL_TTL_SEC = 60 * 60;
const DEFAULT_KEYFRAME_SEC = 1;
/** The family thumbnail text is drawn in (hosted like the overlay fonts, public/fonts/). */
export const THUMBNAIL_FONT_FAMILY = 'Montserrat';

export interface ThumbnailDeps {
  db: PrismaClient;
  storage: AssetStorage;
  composer: ThumbnailComposer;
  bucket: string;
  fontsBaseUrl?: string;
  now: () => number;
}

export const generateThumbnailInput = z
  .object({
    source: z.enum(['keyframe', 'library', 'auto']).default('auto'),
    atSec: z
      .number()
      .min(0)
      .max(12 * 3600)
      .optional(),
    overlayText: z.string().trim().max(120).optional(),
    /** source library: this image; otherwise the highest-engagement image of the business. */
    imageId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export type GenerateThumbnailInput = z.infer<typeof generateThumbnailInput>;

async function findRender(db: PrismaClient, organisationId: string, renderId: string) {
  const render = await db.videoRender.findFirst({
    where: { id: renderId, project: { organisationId, deletedAt: null } },
    include: { project: { select: { id: true, businessId: true } } },
  });
  if (!render) throw new NotFoundError('Render not found');
  return render;
}

/** Signed URL of the render's current thumbnail, or null. */
export async function thumbnailUrlOf(
  deps: Pick<ThumbnailDeps, 'storage' | 'bucket'>,
  render: Pick<VideoRender, 'thumbnailS3Key'>,
): Promise<string | null> {
  return render.thumbnailS3Key
    ? deps.storage.signedUrl(deps.bucket, render.thumbnailS3Key, THUMBNAIL_URL_TTL_SEC)
    : null;
}

/** The business's highest-engagement library image (A6.5), or null when it has none. */
export async function pickLibraryBackground(
  db: PrismaClient,
  scope: { organisationId: string; businessId: string },
): Promise<{ id: string; s3Bucket: string; s3Key: string; publicUrl: string | null } | null> {
  const images = await db.imageLibraryItem.findMany({
    where: { organisationId: scope.organisationId, businessId: scope.businessId },
    select: { id: true, s3Bucket: true, s3Key: true, publicUrl: true, useCount: true },
    orderBy: [{ useCount: 'desc' }, { createdAt: 'desc' }],
    take: 200,
  });
  if (images.length === 0) return null;
  const slides = await db.slideshowSlide.findMany({
    where: { imageAssetId: { in: images.map((i) => i.id) } },
    select: { projectId: true, imageAssetId: true },
  });
  const views = new Map<string, number>();
  if (slides.length) {
    const pubs = await db.videoPublication.findMany({
      where: {
        organisationId: scope.organisationId,
        projectId: { in: [...new Set(slides.map((s) => s.projectId))] },
        state: 'PUBLISHED',
      },
      select: {
        projectId: true,
        analytics: { orderBy: { bucketAt: 'desc' }, take: 1, select: { views: true } },
      },
    });
    const byProject = new Map<string, number>();
    for (const p of pubs)
      byProject.set(p.projectId, (byProject.get(p.projectId) ?? 0) + (p.analytics[0]?.views ?? 0));
    for (const s of slides)
      if (s.imageAssetId)
        views.set(
          s.imageAssetId,
          (views.get(s.imageAssetId) ?? 0) + (byProject.get(s.projectId) ?? 0),
        );
  }
  const ranked = [...images].sort(
    (a, b) => (views.get(b.id) ?? 0) - (views.get(a.id) ?? 0) || b.useCount - a.useCount,
  );
  const best = ranked[0];
  return best
    ? { id: best.id, s3Bucket: best.s3Bucket, s3Key: best.s3Key, publicUrl: best.publicUrl }
    : null;
}

/** The hook text for the overlay: the brief's hook, else the first shot's on-screen text. */
async function defaultOverlayText(db: PrismaClient, render: VideoRender): Promise<string | null> {
  const brief = await db.videoBrief.findUnique({
    where: { projectId: render.projectId },
    select: { hook: true },
  });
  if (brief?.hook?.trim()) return brief.hook.trim();
  const shot = await db.videoShot.findFirst({
    where: { scriptId: render.scriptId, onScreenText: { not: null } },
    orderBy: { sortOrder: 'asc' },
    select: { onScreenText: true },
  });
  return shot?.onScreenText?.trim() || null;
}

async function storeThumbnail(
  deps: ThumbnailDeps,
  render: VideoRender,
  organisationId: string,
  bytes: Uint8Array,
  contentType: 'image/jpeg' | 'image/png',
) {
  const ext = contentType === 'image/png' ? 'png' : 'jpg';
  const key = `orgs/${organisationId}/renders/${render.id}/thumbnail-${deps.now()}.${ext}`;
  await deps.storage.put({ bucket: deps.bucket, key, body: bytes, contentType });
  const updated = await deps.db.videoRender.update({
    where: { id: render.id },
    data: { thumbnailS3Key: key },
  });
  if (render.thumbnailS3Key && render.thumbnailS3Key !== key) {
    // The old file is no longer referenced; a failed delete only leaves an orphan object.
    await deps.storage.delete(deps.bucket, render.thumbnailS3Key).catch(() => undefined);
  }
  return { render: updated, thumbnailUrl: await thumbnailUrlOf(deps, updated) };
}

/** Generate (or regenerate) a render's thumbnail: keyframe + hook overlay (+ library background). */
export async function generateRenderThumbnail(
  deps: ThumbnailDeps,
  organisationId: string,
  renderId: string,
  input: GenerateThumbnailInput,
) {
  const render = await findRender(deps.db, organisationId, renderId);
  if (input.atSec !== undefined && input.atSec > render.durationSec)
    throw new ValidationError(
      `atSec must be within the video (0–${render.durationSec.toFixed(1)}s)`,
    );
  let background: { s3Bucket: string; s3Key: string; publicUrl: string | null } | null = null;
  if (input.source === 'library' && input.imageId) {
    background = await deps.db.imageLibraryItem.findFirst({
      where: { id: input.imageId, organisationId, businessId: render.project.businessId },
      select: { s3Bucket: true, s3Key: true, publicUrl: true },
    });
    if (!background) throw new ValidationError('imageId is not in this business’s image library');
  } else if (input.source !== 'keyframe') {
    background = await pickLibraryBackground(deps.db, {
      organisationId,
      businessId: render.project.businessId,
    });
    if (!background && input.source === 'library')
      throw new ValidationError('This business has no library images yet');
  }
  const overlayText =
    input.overlayText !== undefined
      ? input.overlayText || null
      : await defaultOverlayText(deps.db, render);
  const size = thumbnailSize(render.aspectRatio);
  const bytes = await deps.composer.compose({
    videoUrl: await deps.storage.signedUrl(render.s3Bucket, render.s3Key),
    atSec: input.atSec ?? Math.min(DEFAULT_KEYFRAME_SEC, render.durationSec / 2),
    backgroundUrl: background
      ? background.s3Key
        ? await deps.storage.signedUrl(background.s3Bucket, background.s3Key)
        : (background.publicUrl ?? undefined)
      : undefined,
    overlayText: overlayText ?? undefined,
    ...size,
    fontUrl: deps.fontsBaseUrl
      ? `${deps.fontsBaseUrl.replace(/\/$/, '')}/${hostedFontFileName(THUMBNAIL_FONT_FAMILY)}`
      : undefined,
  });
  return storeThumbnail(deps, render, organisationId, bytes, 'image/jpeg');
}

/** JPEG or PNG by magic bytes (the Content-Type header is not trusted). */
export function imageTypeOf(bytes: Uint8Array): 'image/jpeg' | 'image/png' | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return 'image/png';
  return null;
}

/** Replace a render's thumbnail with an uploaded JPEG/PNG (≤ 8 MB). */
export async function uploadRenderThumbnail(
  deps: ThumbnailDeps,
  organisationId: string,
  renderId: string,
  bytes: Uint8Array,
) {
  if (bytes.byteLength === 0) throw new ValidationError('The thumbnail file is empty');
  if (bytes.byteLength > THUMBNAIL_MAX_BYTES)
    throw new PayloadTooLargeError('Thumbnails can be at most 8 MB');
  const type = imageTypeOf(bytes);
  if (!type) throw new ValidationError('Thumbnails must be JPEG or PNG images');
  const render = await findRender(deps.db, organisationId, renderId);
  return storeThumbnail(deps, render, organisationId, bytes, type);
}

/** Bytes of a render's thumbnail for publishing (null when none, or it cannot be read). */
export async function readThumbnail(
  deps: Pick<ThumbnailDeps, 'storage' | 'bucket'>,
  render: Pick<VideoRender, 'thumbnailS3Key'>,
): Promise<{ bytes: Uint8Array; contentType: 'image/jpeg' | 'image/png' } | null> {
  if (!render.thumbnailS3Key) return null;
  const size = await deps.storage.size(deps.bucket, render.thumbnailS3Key);
  if (size <= 0 || size > THUMBNAIL_MAX_BYTES) return null;
  const bytes = await deps.storage.readRange(deps.bucket, render.thumbnailS3Key, 0, size - 1);
  const contentType = imageTypeOf(bytes);
  return contentType ? { bytes, contentType } : null;
}

/** Thumbnail deps for API routes: injected (tests) or FFmpeg + S3_BUCKET_THUMBNAILS. */
export function thumbnailDepsForApi(deps: {
  db: PrismaClient;
  storage: AssetStorage;
  fontsBaseUrl?: string;
  now: () => number;
  thumbnails?: { composer: ThumbnailComposer; bucket: string };
}): ThumbnailDeps {
  const bucket = deps.thumbnails?.bucket ?? process.env.S3_BUCKET_THUMBNAILS?.trim();
  if (!bucket) throw new ConfigurationError('S3_BUCKET_THUMBNAILS is not set');
  return {
    db: deps.db,
    storage: deps.storage,
    composer: deps.thumbnails?.composer ?? createFfmpegThumbnailComposer(),
    bucket,
    fontsBaseUrl: deps.fontsBaseUrl,
    now: deps.now,
  };
}
