'use client';

import { useTranslations } from 'next-intl';
import { Download, PencilLine, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useFormat } from '@/lib/client/format';
import type { LibraryImage } from '../business/types';
import { requestOf, type ImageRequest } from './image-studio-model';

// BACKLOG 25.8 — one generated image, large: what it was made from, its size, and what you can do
// with it — download (the signed preview URL the library already returns), make it again with the
// same prompt, or put the prompt back in the box to change it. Radix keeps focus inside and
// returns it to the tile on close.

export function ImagePreviewDialog({
  image,
  onClose,
  onGenerateAgain,
  onEditPrompt,
  canGenerate,
  busy,
}: {
  image: LibraryImage | null;
  onClose: () => void;
  onGenerateAgain: (request: ImageRequest) => void;
  onEditPrompt: (request: ImageRequest) => void;
  /** Writer, image generation in the plan, nothing already generating. */
  canGenerate: boolean;
  busy: boolean;
}) {
  const t = useTranslations('images.preview');
  const f = useFormat();
  const request = image ? requestOf(image) : null;
  return (
    <Dialog open={image !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
        {image && (
          <>
            <DialogHeader>
              <DialogTitle>{t('title')}</DialogTitle>
              <DialogDescription className="whitespace-pre-line text-foreground">
                {request?.prompt ?? image.altText ?? ''}
              </DialogDescription>
            </DialogHeader>
            {image.previewUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={image.previewUrl}
                alt={request?.prompt ?? image.altText ?? ''}
                width={image.widthPx}
                height={image.heightPx}
                className="mx-auto block max-h-[60dvh] w-auto max-w-full rounded-lg bg-muted object-contain"
              />
            )}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {request?.style && (
                <>
                  <dt className="text-muted-foreground">{t('style')}</dt>
                  <dd>{request.style}</dd>
                </>
              )}
              <dt className="text-muted-foreground">{t('size')}</dt>
              <dd className="tabular">
                {t('dimensions', { width: image.widthPx, height: image.heightPx })}
              </dd>
              <dt className="text-muted-foreground">{t('made')}</dt>
              <dd>{f.relative(image.createdAt)}</dd>
            </dl>
            <DialogFooter className="gap-2 sm:justify-between">
              {image.previewUrl ? (
                <Button asChild variant="outline">
                  <a href={image.previewUrl} download target="_blank" rel="noopener noreferrer">
                    <Download /> {t('download')}
                  </a>
                </Button>
              ) : (
                <span />
              )}
              {request && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="ghost"
                    disabled={!canGenerate}
                    onClick={() => onEditPrompt(request)}
                  >
                    <PencilLine /> {t('edit')}
                  </Button>
                  <Button
                    disabled={!canGenerate || busy}
                    loading={busy}
                    onClick={() => onGenerateAgain(request)}
                  >
                    {!busy && <RefreshCw />} {t('again')}
                  </Button>
                </div>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
