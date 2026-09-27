'use client';

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '../publications/confirm-dialog';
import type { ImageSource, LibraryImage } from './types';

// The image library as a tight contact sheet: square crops, source + tags on hover/focus,
// delete behind a confirmation.

export const SOURCE_LABEL: Record<ImageSource, string> = {
  SCRAPED: 'Your site',
  STOCK: 'Stock',
  GENERATED: 'Generated',
  UPLOAD: 'Uploaded',
};

function ImageTile({
  image,
  onDelete,
}: {
  image: LibraryImage;
  onDelete: (image: LibraryImage) => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const alt = image.altText || image.tags.slice(0, 3).join(', ') || 'Library image';
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
          No preview
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-foreground/80 to-transparent p-2 text-background opacity-100 transition-opacity md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
        <div className="min-w-0 text-[0.7rem] leading-tight">
          <p className="font-medium">
            {SOURCE_LABEL[image.source]}
            {image.similarity !== undefined && ` · ${Math.round(image.similarity * 100)}% match`}
          </p>
          {image.tags.length > 0 && <p className="truncate opacity-80">{image.tags.join(', ')}</p>}
        </div>
        <Button
          variant="secondary"
          size="icon-xs"
          aria-label={`Delete image: ${alt}`}
          onClick={() => setConfirming(true)}
        >
          <Trash2 />
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete this image?"
        description="It is removed from your library and will not be used in new videos."
        confirmLabel="Delete image"
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
    <ul aria-label={label} className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {images.map((image) => (
        <ImageTile key={image.id} image={image} onDelete={onDelete} />
      ))}
    </ul>
  );
}
