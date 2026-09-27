import type { PrismaClient } from '@prisma/client';
import { ValidationError } from '../../errors';
import type { AssetStorage } from '../storage';
import type { ResolvedSlide } from './edl';
import { kenBurnsSpec, parseSlideContent } from './planner';

// BACKLOG 7.6 — turn slide rows into what the slideshow EDL needs: signed URLs for library
// images (or the hotlink for hotlink-only stock) and video assets, scoped to the project's
// organisation and business.

export async function resolveSlides(
  deps: { db: PrismaClient; storage: AssetStorage },
  project: { id: string; organisationId: string; businessId: string },
): Promise<ResolvedSlide[]> {
  const slides = await deps.db.slideshowSlide.findMany({
    where: { projectId: project.id },
    orderBy: { sortOrder: 'asc' },
  });
  const contents = slides.map((s) => parseSlideContent(s.metadata));
  const imageIds = new Set<string>();
  slides.forEach((s, i) => {
    const c = contents[i];
    for (const id of [s.imageAssetId, c?.beforeImageId, c?.afterImageId]) if (id) imageIds.add(id);
  });
  const videoIds = slides.map((s) => s.videoAssetId).filter((id): id is string => Boolean(id));

  const [images, videos] = await Promise.all([
    deps.db.imageLibraryItem.findMany({
      where: {
        id: { in: [...imageIds] },
        organisationId: project.organisationId,
        businessId: project.businessId,
      },
    }),
    deps.db.videoAsset.findMany({
      where: { id: { in: videoIds }, organisationId: project.organisationId },
    }),
  ]);
  const imageUrl = new Map<string, string>();
  for (const item of images) {
    const url = item.s3Key
      ? await deps.storage.signedUrl(item.s3Bucket, item.s3Key)
      : item.publicUrl;
    if (url) imageUrl.set(item.id, url);
  }
  const videoUrl = new Map<string, string>();
  for (const asset of videos)
    videoUrl.set(asset.id, await deps.storage.signedUrl(asset.s3Bucket, asset.s3Key));

  const need = (id: string | null | undefined, map: Map<string, string>, sortOrder: number) => {
    if (!id) return undefined;
    const url = map.get(id);
    if (!url) throw new ValidationError(`Slide ${sortOrder + 1} references a missing asset`);
    return url;
  };

  return slides.map((s, i) => {
    const content = contents[i] ?? {};
    const burns = kenBurnsSpec.safeParse(s.kenBurnsSpec);
    return {
      slideType: s.slideType,
      durationSec: s.durationSec,
      transitionIn: s.transitionIn,
      imageSrc: need(s.imageAssetId, imageUrl, s.sortOrder),
      videoSrc: need(s.videoAssetId, videoUrl, s.sortOrder),
      beforeSrc: need(content.beforeImageId, imageUrl, s.sortOrder),
      afterSrc: need(content.afterImageId, imageUrl, s.sortOrder),
      backgroundColor: s.backgroundColor,
      kenBurnsEffect: burns.success ? burns.data.effect : undefined,
      content,
    };
  });
}
