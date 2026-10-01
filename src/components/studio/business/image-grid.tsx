'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/client/format';
import { ConfirmDialog } from '../publications/confirm-dialog';
import type { ImageSource, LibraryImage } from './types';

// The image library as a tight contact sheet: square crops, source + tags on hover/focus,
// delete behind a confirmation. 20.16: stock images say where they come from ("Images from
// Pixabay"), on each tile and under the grid, as Pixabay's API terms require whenever search
// results are shown (https://pixabay.com/api/docs/, read 2026-10-01).

/** Every image source, in filter order (labels: business.images.sources.*). */
export const IMAGE_SOURCES: readonly ImageSource[] = ['SCRAPED', 'STOCK', 'GENERATED', 'UPLOAD'];

/** Stock providers' names (brands: not translated). Keys are images/stock.ts provider ids. */
const STOCK_PROVIDER_NAMES: Readonly<Record<string, string>> = {
  pexels: 'Pexels',
  pixabay: 'Pixabay',
  storyblocks: 'Storyblocks',
  unsplash: 'Unsplash',
};

/** The stock provider to credit for an image, or null (not stock, or an unknown provider). */
export function stockProviderName(
  image: Pick<LibraryImage, 'source' | 'sourceProvider'>,
): string | null {
  if (image.source !== 'STOCK' || !image.sourceProvider) return null;
  return STOCK_PROVIDER_NAMES[image.sourceProvider] ?? null;
}

/** "Images from Pixabay and Pexels" under a grid that shows stock images. */
function StockCredit({ images }: { images: LibraryImage[] }) {
  const t = useTranslations('business.images');
  const f = useFormat();
  const names = [...new Set(images.map(stockProviderName).filter((n): n is string => n !== null))];
  if (names.length === 0) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {t('stockCredit', { providers: f.list(names) })}
    </p>
  );
}

function ImageTile({
  image,
  onDelete,
}: {
  image: LibraryImage;
  onDelete: (image: LibraryImage) => Promise<boolean>;
}) {
  const t = useTranslations('business.images');
  const f = useFormat();
  const [confirming, setConfirming] = useState(false);
  const alt = image.altText || image.tags.slice(0, 3).join(', ') || t('fallbackAlt');
  const source = t(`sources.${image.source}`);
  const provider = stockProviderName(image);
  return (
    <li className="group relative overflow-hidden rounded-lg bg-muted">
      {image.previewUrl ? (
        // Signed storage URLs on arbitrary hosts: next/image would need every host allow-listed.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image.previewUrl}
          alt={alt}
          loading="lazy"
          width={image.widthPx}
          height={image.heightPx}
          className="aspect-square w-full object-cover"
        />
      ) : (
        <div className="grid aspect-square place-items-center text-xs text-muted-foreground">
          {t('noPreview')}
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-foreground/80 to-transparent p-2 text-background opacity-100 transition-opacity md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
        <div className="min-w-0 text-[0.7rem] leading-tight">
          <p className="font-medium">
            {image.similarity !== undefined
              ? t('sourceMatch', { source, percent: f.percent(image.similarity) })
              : source}
          </p>
          {provider && <p className="opacity-80">{t('stockCredit', { providers: provider })}</p>}
          {image.tags.length > 0 && <p className="truncate opacity-80">{image.tags.join(', ')}</p>}
        </div>
        <Button
          variant="secondary"
          size="icon-xs"
          aria-label={t('deleteAria', { alt })}
          onClick={() => setConfirming(true)}
        >
          <Trash2 />
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('deleteConfirm.title')}
        description={t('deleteConfirm.body')}
        confirmLabel={t('deleteConfirm.confirm')}
        onConfirm={() => onDelete(image)}
      />
    </li>
  );
}

export function ImageGrid({
  images,
  onDelete,
  label,
}: {
  images: LibraryImage[];
  onDelete: (image: LibraryImage) => Promise<boolean>;
  label: string;
}) {
  return (
    <>
      <ul aria-label={label} className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {images.map((image) => (
          <ImageTile key={image.id} image={image} onDelete={onDelete} />
        ))}
      </ul>
      <StockCredit images={images} />
    </>
  );
}
