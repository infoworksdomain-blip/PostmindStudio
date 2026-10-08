import { aspectOfSize, mediaAspect, type MediaAspect } from '@/components/ui/media-tile';
import { MEDIA_FILTERS, type MediaFilter, type MediaItem } from './types';

// BACKLOG 25.10 — pure helpers for My media: the segment from the URL, each item's shape and
// what it can be opened as.

export const TYPE_PARAM = 'type';

/** The segment the URL asks for, else All. */
export function resolveFilter(value: string | null | undefined): MediaFilter {
  return (MEDIA_FILTERS as readonly string[]).includes(value ?? '')
    ? (value as MediaFilter)
    : 'all';
}

/** The query string with `type` set (removed for All), as `?…` or ''. */
export function withFilter(search: string, filter: MediaFilter): string {
  const params = new URLSearchParams(search);
  if (filter === 'all') params.delete(TYPE_PARAM);
  else params.set(TYPE_PARAM, filter);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** The item's own shape (renders say it, uploads and images by their pixel size). */
export function aspectOfItem(item: MediaItem): MediaAspect {
  if (item.type === 'video') return mediaAspect(item.aspectRatio);
  if (item.type === 'upload') return aspectOfSize(item.width, item.height);
  return aspectOfSize(item.widthPx, item.heightPx, '1:1');
}

/** Width × height when known. */
export function sizeOfItem(item: MediaItem): { width: number; height: number } | null {
  const [width, height] =
    item.type === 'image' ? [item.widthPx, item.heightPx] : [item.width, item.height];
  return width && height ? { width, height } : null;
}

/** The still shown in the grid; uploads have none (their tile previews the video on hover). */
export function posterOfItem(item: MediaItem): string | null {
  if (item.type === 'video') return item.thumbnailUrl;
  if (item.type === 'image') return item.previewUrl;
  return null;
}

export function durationOfItem(item: MediaItem): number | null {
  return item.type === 'image' ? null : item.durationSec;
}

/** The project a render (or an upload a project used) belongs to. */
export function projectOfItem(item: MediaItem): string | null {
  return item.type === 'image' ? null : item.projectId;
}
