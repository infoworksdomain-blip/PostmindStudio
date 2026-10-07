import type { PrismaClient, VideoProject } from '@prisma/client';
import { CAROUSEL_RENDER_PLATFORM } from '../carousel/publishing';
import { readWallOfText, wallShownSec } from '../formats/wall-of-text';
import type { LiveFormat } from '../live/eta';
import { parseSlideContent, type SlideContent } from '../slideshow/planner';
import type { AssetStorage } from '../storage';
import { latestRender } from './carousels';

// BACKLOG 24.2 — what the calendar side panel's instant preview plays (Remotion Player): the
// finished render when there is one; before that, what the post is made of — carousel slides,
// slideshow slides (text + picture + their durations), the wall-of-text block, or a video's
// storyboard (its shot list, with a still where a shot's picture exists). All URLs are signed
// for an hour; every query is scoped to the project the caller already resolved for its
// organisation.

export const PREVIEW_URL_TTL_SEC = 60 * 60;
/** Carousel slides have no duration of their own: the preview pages through them at this pace. */
export const CAROUSEL_SECONDS_PER_SLIDE = 3;

export interface PreviewSlide {
  imageUrl: string | null;
  text: string | null;
  durationSec: number;
}

export interface StoryboardShot {
  id: string;
  sortOrder: number;
  durationSec: number;
  text: string | null;
  stillUrl: string | null;
  state: string;
}

export type PreviewMedia =
  | { kind: 'video'; url: string; posterUrl: string | null; durationSec: number }
  | { kind: 'slides'; rendered: boolean; slides: PreviewSlide[] }
  | { kind: 'text'; text: string; durationSec: number }
  | { kind: 'storyboard'; shots: StoryboardShot[] }
  | { kind: 'none' };

export interface MediaDeps {
  db: PrismaClient;
  storage: AssetStorage;
}

type Project = Pick<VideoProject, 'id' | 'organisationId' | 'metadata'>;

const sign = (deps: MediaDeps, bucket: string, key: string | null | undefined) =>
  key ? deps.storage.signedUrl(bucket, key, PREVIEW_URL_TTL_SEC) : Promise.resolve(null);

/** The newest finished video render (never the carousel's PNG render). */
export async function latestVideoRender(db: Pick<PrismaClient, 'videoRender'>, projectId: string) {
  return db.videoRender.findFirst({
    where: { projectId, targetPlatform: { not: CAROUSEL_RENDER_PLATFORM } },
    orderBy: { createdAt: 'desc' },
    select: {
      s3Bucket: true,
      s3Key: true,
      thumbnailS3Key: true,
      durationSec: true,
      aspectRatio: true,
    },
  });
}

/** The words a slideshow slide shows, whichever slide type it is. */
export function slideText(content: SlideContent): string | null {
  const parts = [
    content.text,
    content.quote,
    content.value && content.label ? `${content.value} ${content.label}` : content.value,
    content.name,
    content.caption,
  ].filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
  return parts.length ? parts.join('\n') : null;
}

async function slideshowSlides(deps: MediaDeps, project: Project): Promise<PreviewSlide[]> {
  const slides = await deps.db.slideshowSlide.findMany({
    where: { projectId: project.id },
    orderBy: { sortOrder: 'asc' },
    select: { imageAssetId: true, durationSec: true, metadata: true },
  });
  const imageIds = [
    ...new Set(slides.map((s) => s.imageAssetId).filter((id): id is string => !!id)),
  ];
  const images = imageIds.length
    ? await deps.db.imageLibraryItem.findMany({
        where: { id: { in: imageIds }, organisationId: project.organisationId },
        select: { id: true, s3Bucket: true, s3Key: true },
      })
    : [];
  const urls = new Map(
    await Promise.all(
      images.map(async (i) => [i.id, await sign(deps, i.s3Bucket, i.s3Key)] as const),
    ),
  );
  return slides.map((s) => ({
    imageUrl: (s.imageAssetId && urls.get(s.imageAssetId)) || null,
    text: slideText(parseSlideContent(s.metadata)),
    durationSec: s.durationSec,
  }));
}

async function storyboard(deps: MediaDeps, project: Project): Promise<StoryboardShot[]> {
  const script = await deps.db.videoScript.findFirst({
    where: { projectId: project.id },
    orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
    select: {
      shots: {
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          sortOrder: true,
          durationSec: true,
          onScreenText: true,
          voiceoverText: true,
          sceneDescription: true,
          state: true,
          assetId: true,
        },
      },
    },
  });
  if (!script) return [];
  const assetIds = script.shots.map((s) => s.assetId).filter((id): id is string => !!id);
  const stills = assetIds.length
    ? await deps.db.videoAsset.findMany({
        where: { id: { in: assetIds }, projectId: project.id, kind: 'IMAGE' },
        select: { id: true, s3Bucket: true, s3Key: true },
      })
    : [];
  const urls = new Map(
    await Promise.all(
      stills.map(async (a) => [a.id, await sign(deps, a.s3Bucket, a.s3Key)] as const),
    ),
  );
  return script.shots.map((s) => ({
    id: s.id,
    sortOrder: s.sortOrder,
    durationSec: s.durationSec,
    text: s.onScreenText || s.voiceoverText || s.sceneDescription || null,
    stillUrl: (s.assetId && urls.get(s.assetId)) || null,
    state: s.state,
  }));
}

/** What the preview plays for a project of `format`. */
export async function previewMedia(
  deps: MediaDeps,
  project: Project,
  format: LiveFormat | null,
): Promise<{ media: PreviewMedia; renderAspect: string | null }> {
  if (format === 'carousel') {
    const render = await latestRender(deps.db, deps.storage, project);
    const slides = (render?.slides ?? []).map((s) => ({
      imageUrl: s.pngUrl,
      text: null,
      durationSec: CAROUSEL_SECONDS_PER_SLIDE,
    }));
    return {
      media: slides.length ? { kind: 'slides', rendered: true, slides } : { kind: 'none' },
      renderAspect: '4:5',
    };
  }
  const render = await latestVideoRender(deps.db, project.id);
  if (render?.s3Key) {
    const url = await sign(deps, render.s3Bucket, render.s3Key);
    if (url)
      return {
        media: {
          kind: 'video',
          url,
          posterUrl: await sign(deps, render.s3Bucket, render.thumbnailS3Key),
          durationSec: render.durationSec,
        },
        renderAspect: render.aspectRatio,
      };
  }
  if (format === 'slideshow') {
    const slides = await slideshowSlides(deps, project);
    return {
      media: slides.length ? { kind: 'slides', rendered: false, slides } : { kind: 'none' },
      renderAspect: null,
    };
  }
  if (format === 'wall_of_text') {
    const wall = readWallOfText(project.metadata);
    const text = wall?.writtenText ?? wall?.text ?? null;
    return {
      media:
        wall && text
          ? { kind: 'text', text, durationSec: wallShownSec(wall.durationSec, text) }
          : { kind: 'none' },
      renderAspect: null,
    };
  }
  const shots = await storyboard(deps, project);
  return {
    media: shots.length ? { kind: 'storyboard', shots } : { kind: 'none' },
    renderAspect: null,
  };
}
