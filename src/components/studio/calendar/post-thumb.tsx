'use client';

import { ImageIcon } from 'lucide-react';
import { useApi } from '@/lib/client/api';
import type { PostPreview } from '@/lib/studio/services/post-preview';
import { cn } from '@/lib/utils';
import { useLiveStatus } from '../live/live-projects-context';

// BACKLOG 25.9 — a post's thumbnail on the week and day views. GET /publications carries no
// media, so the thumbnail comes from what already exists: the live event's thumbnailUrl (24.2)
// or, loaded lazily for this card only, the post preview's poster / first slide
// (GET /projects/:id/preview, the side panel's own request, so opening the panel is instant).
// Decorative: the card's own label names the post.

type PreviewMedia = PostPreview['media'];

export function posterOf(media: PreviewMedia | undefined): string | null {
  if (!media) return null;
  if (media.kind === 'video') return media.posterUrl;
  if (media.kind === 'slides') return media.slides.find((s) => s.imageUrl)?.imageUrl ?? null;
  return null;
}

export function PostThumb({
  projectId,
  className,
  hideEmpty = false,
}: {
  projectId: string;
  className?: string;
  /** Render nothing until there is a picture (narrow week columns). */
  hideEmpty?: boolean;
}) {
  const live = useLiveStatus(projectId);
  const liveThumb = live?.thumbnailUrl ?? null;
  const { data } = useApi<{ preview: PostPreview }>(
    liveThumb ? null : `/projects/${projectId}/preview`,
  );
  const url = liveThumb ?? posterOf(data?.preview.media);
  if (!url && hideEmpty) return null;
  return (
    <span
      aria-hidden
      data-post-thumb={url ? 'image' : 'none'}
      className={cn(
        'relative grid shrink-0 place-items-center overflow-hidden rounded-control bg-surface-raised text-muted-foreground',
        className,
      )}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived storage URL
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 size-full object-cover"
        />
      ) : (
        <ImageIcon className="size-4" strokeWidth={1.5} />
      )}
    </span>
  );
}
