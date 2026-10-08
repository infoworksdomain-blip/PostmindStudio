import type { MediaImage, MediaUpload, MediaVideo } from './types';

// Test-only fixtures for My media.

export function videoItem(over: Partial<MediaVideo> = {}): MediaVideo {
  return {
    type: 'video',
    id: 'rnd_1',
    projectId: 'proj_1',
    businessId: 'biz_1',
    title: 'Sourdough launch',
    projectState: 'APPROVED',
    platform: 'tiktok',
    aspectRatio: '9:16',
    width: 1080,
    height: 1920,
    durationSec: 21,
    createdAt: '2026-10-07T10:00:00.000Z',
    thumbnailUrl: 'https://cdn.test/thumb.jpg',
    ...over,
  };
}

export function uploadItem(over: Partial<MediaUpload> = {}): MediaUpload {
  return {
    type: 'upload',
    id: 'upl_1',
    kind: 'source_video',
    businessId: 'biz_1',
    projectId: null,
    title: 'shop-tour.mp4',
    width: 1080,
    height: 1920,
    durationSec: 34,
    sizeBytes: 18_400_000,
    createdAt: '2026-10-06T10:00:00.000Z',
    previewUrl: 'https://cdn.test/upload.mp4',
    ...over,
  };
}

export function imageItem(over: Partial<MediaImage> = {}): MediaImage {
  return {
    type: 'image',
    id: 'img_1',
    businessId: 'biz_1',
    source: 'UPLOAD',
    sourceUrl: null,
    sourceProvider: null,
    publicUrl: null,
    previewUrl: 'https://cdn.test/img.jpg',
    hotlinked: false,
    widthPx: 1600,
    heightPx: 1200,
    fileSizeBytes: 200_000,
    tags: [],
    altText: 'Loaves on a rack',
    generatedFromPrompt: null,
    licenseNotes: null,
    useCount: 0,
    createdAt: '2026-10-05T10:00:00.000Z',
    ...over,
  };
}
