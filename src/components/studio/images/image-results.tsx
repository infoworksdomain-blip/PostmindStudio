'use client';

import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import type { LibraryImage } from '../business/types';
import { requestOf, type ImageAspect } from './image-studio-model';

// BACKLOG 25.8 — the business's generated images, newest first, as a contact sheet. Each tile
// opens the preview; while an image is being made, a tile in its shape holds its place.

const TILE_ASPECT: Record<ImageAspect, string> = {
  '1:1': 'aspect-square',
  '4:5': 'aspect-[4/5]',
  '9:16': 'aspect-[9/16]',
  '16:9': 'aspect-video',
};

export function PendingTile({ aspect }: { aspect: ImageAspect }) {
  const t = useTranslations('images.results');
  return (
    <li className="break-inside-avoid pb-3">
      <div
        className={cn(
          'grid place-items-center rounded-lg border border-dashed border-border-strong bg-muted text-sm text-muted-foreground',
          TILE_ASPECT[aspect],
        )}
      >
        <span className="flex items-center gap-2">
          <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" />
          {t('pending')}
        </span>
      </div>
    </li>
  );
}

function ImageTile({ image, onOpen }: { image: LibraryImage; onOpen: () => void }) {
  const t = useTranslations('images.results');
  const f = useFormat();
  const prompt = requestOf(image)?.prompt ?? image.altText ?? t('untitled');
  return (
    <li className="break-inside-avoid pb-3">
      <button
        type="button"
        onClick={onOpen}
        aria-label={t('open', { prompt })}
        className="group relative block w-full overflow-hidden rounded-lg bg-muted text-start focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
      >
        {image.previewUrl ? (
          // Signed storage URLs on arbitrary hosts: next/image would need every host allow-listed.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image.previewUrl}
            alt=""
            loading="lazy"
            width={image.widthPx}
            height={image.heightPx}
            className="block h-auto w-full motion-safe:transition-transform motion-safe:duration-300 motion-safe:group-hover:scale-[1.02]"
          />
        ) : (
          <span className="grid aspect-square place-items-center text-xs text-muted-foreground">
            {t('noPreview')}
          </span>
        )}
        <span className="absolute inset-x-0 bottom-0 flex flex-col gap-0.5 bg-gradient-to-t from-black/75 to-transparent p-2.5 pt-8 text-xs text-white">
          <span className="line-clamp-2 font-medium">{prompt}</span>
          <span className="opacity-80">{f.relative(image.createdAt)}</span>
        </span>
      </button>
    </li>
  );
}

export function ImageResults({
  images,
  pending,
  onOpen,
}: {
  images: readonly LibraryImage[];
  pending: ImageAspect | null;
  onOpen: (image: LibraryImage) => void;
}) {
  const t = useTranslations('images.results');
  return (
    <ul aria-label={t('aria')} className="columns-2 gap-3 sm:columns-3 xl:columns-4">
      {pending && <PendingTile aspect={pending} />}
      {images.map((image) => (
        <ImageTile key={image.id} image={image} onOpen={() => onOpen(image)} />
      ))}
    </ul>
  );
}
