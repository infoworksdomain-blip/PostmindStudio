// Pictures and logo bytes for a carousel render (21.6), from Studio storage only: library images
// must be stored (not hotlinked) and the logo is the brand kit's READY BRAND_LOGO upload.
import type { PrismaClient } from '@prisma/client';
import { NotFoundError, ValidationError } from '../../errors';
import type { AssetStorage } from '../storage';
import type { CarouselImage } from './types';

type AssetDb = Pick<PrismaClient, 'imageLibraryItem' | 'videoUpload' | 'brandKit'>;

export interface BusinessRef {
  readonly organisationId: string;
  readonly businessId: string;
}

async function readObject(storage: AssetStorage, bucket: string, key: string): Promise<Buffer> {
  const size = await storage.size(bucket, key);
  if (size <= 0) throw new NotFoundError('A picture of this carousel is missing from storage');
  return Buffer.from(await storage.readRange(bucket, key, 0, size - 1));
}

/** Library images (by id) of the business, as CarouselImage records; unknown ids are a 400. */
export async function carouselImages(
  db: AssetDb,
  scope: BusinessRef,
  ids: readonly string[],
): Promise<Map<string, CarouselImage>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db.imageLibraryItem.findMany({
    where: {
      id: { in: unique },
      organisationId: scope.organisationId,
      businessId: scope.businessId,
    },
    select: { id: true, widthPx: true, heightPx: true, source: true, s3Key: true },
  });
  const found = new Map(
    rows
      .filter((r) => r.s3Key && r.widthPx > 0 && r.heightPx > 0)
      .map((r): [string, CarouselImage] => [
        r.id,
        {
          imageId: r.id,
          width: r.widthPx,
          height: r.heightPx,
          aiGenerated: r.source === 'GENERATED',
        },
      ]),
  );
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length)
    throw new ValidationError('Some pictures are not in this business’s image library', {
      imageIds: missing,
    });
  return found;
}

/** Loads a library picture's bytes (scoped to the business). */
export function libraryImageLoader(
  deps: { db: AssetDb; storage: AssetStorage },
  scope: BusinessRef,
): (imageId: string) => Promise<Buffer> {
  return async (imageId) => {
    const item = await deps.db.imageLibraryItem.findFirst({
      where: { id: imageId, organisationId: scope.organisationId, businessId: scope.businessId },
      select: { s3Bucket: true, s3Key: true },
    });
    if (!item?.s3Key) throw new NotFoundError('A picture of this carousel is no longer available');
    return readObject(deps.storage, item.s3Bucket, item.s3Key);
  };
}

/** The business's brand kit logo upload id (project kit, else the default kit), or null. */
export async function brandLogoUploadId(
  db: AssetDb,
  scope: BusinessRef,
  brandKitId: string | null | undefined,
): Promise<string | null> {
  const kit = await db.brandKit.findFirst({
    where: brandKitId
      ? { id: brandKitId, organisationId: scope.organisationId }
      : {
          organisationId: scope.organisationId,
          businessId: scope.businessId,
          isDefault: true,
          deletedAt: null,
        },
    select: { logoAssetId: true },
  });
  return kit?.logoAssetId ?? null;
}

/** The logo's bytes, or null when the upload is gone or not ready (an initial is drawn instead). */
export async function loadLogo(
  deps: { db: AssetDb; storage: AssetStorage },
  organisationId: string,
  uploadId: string | null,
): Promise<Buffer | null> {
  if (!uploadId) return null;
  const upload = await deps.db.videoUpload.findFirst({
    where: { id: uploadId, organisationId, kind: 'BRAND_LOGO', state: 'READY' },
    select: { s3Bucket: true, s3Key: true },
  });
  if (!upload) return null;
  try {
    return await readObject(deps.storage, upload.s3Bucket, upload.s3Key);
  } catch {
    // A missing logo must not stop the carousel: the avatar falls back to the initial.
    return null;
  }
}
