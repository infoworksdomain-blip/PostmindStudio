'use client';

import { Film } from 'lucide-react';
import { useApi } from '@/lib/client/api';
import { cn } from '@/lib/utils';

// BACKLOG 25.11 — a published post's poster frame: the render's thumbnail (GET /renders/:id, the
// signed thumbnailUrl of 15.A3, shared SWR cache with the review screen). Decorative: the caption
// beside it names the post. A quiet film glyph stands in while it loads or when there is none, in
// the same 9:16 box, so rows never shift.

export function PostThumbnail({
  renderId,
  className,
}: {
  renderId?: string | null;
  className?: string;
}) {
  const { data } = useApi<{ render: { thumbnailUrl?: string | null } }>(
    renderId ? `/renders/${encodeURIComponent(renderId)}` : null,
  );
  const url = data?.render.thumbnailUrl ?? null;
  return (
    <span
      aria-hidden
      className={cn(
        'relative grid aspect-[9/16] shrink-0 place-items-center overflow-hidden bg-secondary text-muted-foreground',
        className,
      )}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived thumbnail URL
        <img src={url} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
      ) : (
        <Film className="size-4" strokeWidth={1.5} />
      )}
    </span>
  );
}
