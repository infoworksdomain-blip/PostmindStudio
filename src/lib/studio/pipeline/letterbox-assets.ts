import type { Prisma, VideoAsset } from '@prisma/client';
import type { Crop } from './edl-stacked';
import type { PipelineDeps } from './deps';
import { detectLetterbox, hasBars, letterboxMeasured, letterboxOf } from './letterbox';

// 22.6 — the bars of every video clip a render uses. Generated and stock clips are measured when
// they are stored (generate-asset.ts recordAsset); clips stored another way (library footage, a
// demo or other upload, a reused asset made before 22.6) are measured here the first time they
// are composed and the result is kept on the asset, so later renders do not measure again.
// Detection errors are logged and the clip is used uncropped (detectLetterbox never throws).

type ClipAsset = Pick<VideoAsset, 'id' | 'kind' | 's3Bucket' | 's3Key' | 'metadata'>;

export async function clipLetterboxes(
  deps: Pick<PipelineDeps, 'db' | 'media' | 'storage' | 'logger'>,
  assets: Iterable<ClipAsset>,
): Promise<Map<string, Crop>> {
  const bars = new Map<string, Crop>();
  for (const asset of assets) {
    if (asset.kind !== 'VIDEO_CLIP') continue;
    if (letterboxMeasured(asset.metadata)) {
      const known = letterboxOf(asset.metadata);
      if (known) bars.set(asset.id, known);
      continue;
    }
    const found = await detectLetterbox(
      deps.media,
      () => deps.storage.signedUrl(asset.s3Bucket, asset.s3Key),
      deps.logger,
      { assetId: asset.id },
    );
    if (!found) continue;
    if (hasBars(found)) bars.set(asset.id, found);
    try {
      await deps.db.videoAsset.update({
        where: { id: asset.id },
        data: {
          metadata: {
            ...((asset.metadata as Record<string, unknown> | null) ?? {}),
            letterbox: { ...found },
          } as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      deps.logger.warn(
        { assetId: asset.id, err: err instanceof Error ? err.message : String(err) },
        'could not record the clip bars; they will be measured again next render',
      );
    }
  }
  return bars;
}
