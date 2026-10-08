import type { LibraryImage } from '../business/types';

// Response shapes of GET /api/studio/media (src/lib/studio/services/media.ts), as the browser
// sees them. Kept by hand — the UI never imports server modules.

export const MEDIA_FILTERS = ['all', 'video', 'image', 'upload'] as const;
export type MediaFilter = (typeof MEDIA_FILTERS)[number];

/** A finished render of one of the organisation's projects. */
export interface MediaVideo {
  type: 'video';
  id: string;
  projectId: string;
  businessId: string;
  title: string | null;
  projectState: string;
  platform: string;
  aspectRatio: string;
  width: number | null;
  height: number | null;
  durationSec: number;
  createdAt: string;
  thumbnailUrl: string | null;
}

/** A READY uploaded video (source video or demo video). */
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

/** An image-library item, as GET /image-library presents it. */
export type MediaImage = { type: 'image' } & LibraryImage;

export type MediaItem = MediaVideo | MediaUpload | MediaImage;

export interface MediaPage {
  data: MediaItem[];
  nextCursor: string | null;
}
