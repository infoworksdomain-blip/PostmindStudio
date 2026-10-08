// 25.10 demo: GET /media — My media, built from what the demo already holds, as
// services/media.ts builds it: finished renders (PASSED / FORCE_APPROVED) of the demo projects
// with their thumbnails, READY uploaded videos (the seeded demo video and anything uploaded in
// this tab) and the image library; newest first, ?type= and ?businessId= filters, cursor pages.
// Uploads play a recorded sample clip (the real app signs the stored file).
import type { MediaItem } from '@/components/studio/media/types';
import { sampleVideo } from '../../media';
import { DEMO_BUSINESS_ID } from '../ids';
import { DemoHttpError, route } from '../registry';
import { libraryImages } from './business-images';
import { readyVideoUploads, seedDemoVideo } from './p13-a1-uploads';
import { demoRenderThumbnail } from './p15-a-publishing';
import { allProjects } from './projects-store';

const TYPES = new Set(['all', 'video', 'image', 'upload']);
const FINISHED = new Set(['PASSED', 'FORCE_APPROVED']);
/** Don't hold the list for a slow canvas recording: the tile then has no hover preview. */
const CLIP_WAIT_MS = 1500;

function sizeOf(resolution: string): [number | null, number | null] {
  const match = /^(\d+)x(\d+)$/.exec(resolution);
  return match ? [Number(match[1]), Number(match[2])] : [null, null];
}

function videos(businessId: string | null): MediaItem[] {
  return allProjects()
    .filter((p) => businessId === null || p.businessId === businessId)
    .flatMap((p) =>
      p.renders
        .filter((r) => FINISHED.has(r.qualityCheckState))
        .map((r): MediaItem => {
          const [width, height] = sizeOf(r.resolution);
          return {
            type: 'video',
            id: r.id,
            projectId: p.id,
            businessId: p.businessId,
            title: p.name,
            projectState: p.state,
            platform: r.targetPlatform,
            aspectRatio: r.aspectRatio,
            width,
            height,
            durationSec: r.durationSec,
            createdAt: r.createdAt,
            thumbnailUrl: demoRenderThumbnail(r.id),
          };
        }),
    );
}

async function clip(caption: string): Promise<string> {
  const timeout = new Promise<string>((resolve) => setTimeout(() => resolve(''), CLIP_WAIT_MS));
  return Promise.race([
    sampleVideo({ scene: 'baker', aspect: '9:16', seconds: 4, caption }),
    timeout,
  ]);
}

async function uploads(businessId: string | null): Promise<MediaItem[]> {
  seedDemoVideo(DEMO_BUSINESS_ID);
  return Promise.all(
    readyVideoUploads(businessId).map(async (u): Promise<MediaItem> => ({
      type: 'upload',
      id: u.id,
      kind: u.kind === 'demo_video' ? 'demo_video' : 'source_video',
      businessId: u.businessId ?? null,
      projectId: u.projectId,
      title: u.fileName,
      width: u.width,
      height: u.height,
      durationSec: u.durationSec,
      sizeBytes: u.sizeBytes,
      createdAt: u.completedAt ?? new Date().toISOString(),
      previewUrl: await clip(u.fileName.replace(/\.[a-z0-9]+$/i, '')),
    })),
  );
}

route('GET', '/media', async ({ query }) => {
  const type = query.get('type') ?? 'all';
  if (!TYPES.has(type)) throw new DemoHttpError(400, 'validation_error', 'type is not valid');
  const limit = Math.min(Math.max(Number(query.get('limit') ?? 24) || 24, 1), 60);
  const offset = Number(query.get('cursor') ?? 0) || 0;
  const businessId = query.get('businessId');
  const all: MediaItem[] = [
    ...(type === 'all' || type === 'video' ? videos(businessId) : []),
    ...(type === 'all' || type === 'upload' ? await uploads(businessId) : []),
    ...(type === 'all' || type === 'image'
      ? libraryImages(businessId ?? DEMO_BUSINESS_ID).map((i): MediaItem => ({
          type: 'image',
          ...i,
        }))
      : []),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const page = all.slice(offset, offset + limit);
  return {
    data: page,
    nextCursor: offset + limit < all.length ? String(offset + limit) : null,
  };
});
