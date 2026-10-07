'use client';

import { Clapperboard } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { forwardRef, type ReactNode } from 'react';
import { ChoiceChips } from '@/components/ui/choice-chips';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import type { Render } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import type { SignedUrl } from './types';

// BACKLOG 25.8 — the review screen's player: the chosen variant, large and in its own shape, with
// its thumbnail as the poster and the browser's own controls (play / pause, scrub, mute, full
// screen — keyboard accessible everywhere). One chip per format switches the variant.

/** The frame per aspect ratio: tall formats as tall as the viewport allows (less on phones, so the
 * status shows below), wide ones fill. */
const FRAME: Record<string, string> = {
  '9:16':
    'aspect-[9/16] w-[min(100%,calc(min(56svh,44rem)*0.5625))] lg:w-[min(100%,calc(min(72vh,44rem)*0.5625))]',
  '4:5':
    'aspect-[4/5] w-[min(100%,calc(min(56svh,40rem)*0.8))] lg:w-[min(100%,calc(min(72vh,40rem)*0.8))]',
  '1:1': 'aspect-square w-[min(100%,min(56svh,36rem))] lg:w-[min(100%,min(72vh,36rem))]',
  '16:9': 'aspect-video w-full',
};

export function frameClass(aspectRatio: string): string {
  return cn(
    'mx-auto block max-w-full overflow-hidden rounded-xl bg-foreground/90 shadow-sm',
    FRAME[aspectRatio] ?? FRAME['16:9'],
  );
}

export function VariantPlayer({ render }: { render: Render }) {
  const t = useTranslations('review.variant');
  const f = useFormat();
  const errorMessage = useErrorMessage();
  const { data, error, isLoading } = useApi<SignedUrl>(`/renders/${render.id}/preview`);
  // The variant's thumbnail (15.A3) doubles as the poster; shared SWR cache with VariantThumbnail.
  const thumb = useApi<{ render: { thumbnailUrl?: string | null } }>(`/renders/${render.id}`);
  const frame = frameClass(render.aspectRatio);
  if (isLoading) return <Skeleton className={frame} aria-label={t('loadingPreview')} />;
  if (error || !data)
    return (
      <div className={cn(frame, 'grid place-items-center p-4 text-center text-sm text-background')}>
        {t('previewUnavailable', { error: errorMessage(error) })}
      </div>
    );
  return (
    <video
      key={render.id}
      className={cn(frame, 'object-contain')}
      src={data.url}
      poster={thumb.data?.render.thumbnailUrl ?? undefined}
      controls
      playsInline
      preload="metadata"
      aria-label={t('previewAria', { platform: f.platform(render.targetPlatform) })}
    />
  );
}

/** Before there is a video: what is happening, in the shape of the first format. */
function Placeholder({ aspectRatio, children }: { aspectRatio: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        frameClass(aspectRatio),
        'grid place-items-center bg-muted p-6 text-center text-sm text-muted-foreground',
      )}
    >
      <div className="flex max-w-56 flex-col items-center gap-3">
        <Clapperboard aria-hidden strokeWidth={1.25} className="size-8" />
        {children}
      </div>
    </div>
  );
}

export const ReviewPlayer = forwardRef<
  HTMLElement,
  {
    renders: readonly Render[];
    selected: Render | null;
    onSelect: (renderId: string) => void;
    working: boolean;
    placeholderAspect: string;
  }
>(function ReviewPlayer({ renders, selected, onSelect, working, placeholderAspect }, ref) {
  const t = useTranslations('review.player');
  const f = useFormat();
  return (
    <section
      ref={ref}
      aria-label={t('aria')}
      tabIndex={-1}
      className="flex flex-col gap-3 outline-none"
    >
      {selected ? (
        <VariantPlayer render={selected} />
      ) : (
        <Placeholder aspectRatio={placeholderAspect}>
          <p>{working ? t('working') : t('none')}</p>
        </Placeholder>
      )}
      {renders.length > 1 && selected && (
        <ChoiceChips
          type="single"
          size="sm"
          label={t('formats')}
          className="justify-center"
          value={selected.id}
          onChange={onSelect}
          options={renders.map((r) => ({
            value: r.id,
            label: (
              <>
                {f.platform(r.targetPlatform)}
                <span className="tabular text-muted-foreground">{r.aspectRatio}</span>
              </>
            ),
          }))}
        />
      )}
    </section>
  );
});
