'use client';

import Link from 'next/link';
import type { RefObject } from 'react';
import { ArrowUpRight, Download } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { api, useApi, useErrorMessage } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { StudioCapability } from '@/lib/rbac';
import { cn } from '@/lib/utils';
import { useCan } from '../use-can';
import { aspectOfItem, durationOfItem, projectOfItem, sizeOfItem } from './media-model';
import { useItemLabels } from './media-item-tile';
import type { MediaItem, MediaVideo } from './types';

// BACKLOG 25.10 — one item of My media, large: the video plays (a render through its signed
// preview URL, GET /renders/:id/preview; an upload through the URL the list signed), an image
// shows whole. Download uses the existing signed URLs (renders: GET /renders/:id/download, which
// needs studio:render:download), and "Open project" goes to the render's project. Radix keeps
// focus inside and returns it to the tile on close.

interface SignedUrl {
  url: string;
  expiresInSec: number;
}

const PLAYER = 'mx-auto block max-h-[60dvh] max-w-full rounded-lg bg-black object-contain';

function RenderPlayer({ item, label }: { item: MediaVideo; label: string }) {
  const t = useTranslations('media.preview');
  const errorMessage = useErrorMessage();
  const { data, error } = useApi<SignedUrl>(`/renders/${item.id}/preview`);
  if (error) return <p className="text-sm text-muted-foreground">{errorMessage(error)}</p>;
  if (!data)
    return (
      <Skeleton
        aria-label={t('loading')}
        className={cn(
          'mx-auto rounded-lg',
          aspectOfItem(item) === '16:9' ? 'aspect-video w-full' : 'aspect-[9/16] h-[50dvh]',
        )}
      />
    );
  return (
    <video
      src={data.url}
      poster={item.thumbnailUrl ?? undefined}
      controls
      playsInline
      preload="metadata"
      aria-label={label}
      className={PLAYER}
    />
  );
}

function Details({ item }: { item: MediaItem }) {
  const t = useTranslations('media.preview');
  const f = useFormat();
  const labels = useItemLabels();
  const size = sizeOfItem(item);
  const duration = durationOfItem(item);
  const rows: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: t('type'), value: `${labels.type(item)} · ${labels.pill(item).label}` },
  ];
  if (item.type === 'video') rows.push({ label: t('format'), value: f.platform(item.platform) });
  if (duration) rows.push({ label: t('length'), value: f.duration(duration), mono: true });
  if (size) rows.push({ label: t('size'), value: t('dimensions', size), mono: true });
  rows.push({ label: t('added'), value: f.date(item.createdAt) });
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className={cn(row.mono && 'font-mono')}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DownloadAction({ item }: { item: MediaItem }) {
  const t = useTranslations('media.preview');
  const errorMessage = useErrorMessage();
  const mayDownload = useCan(StudioCapability.RenderDownload);

  async function downloadRender(id: string) {
    try {
      const { url } = await api<SignedUrl>(`/renders/${id}/download`);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  if (item.type === 'video')
    return mayDownload ? (
      <Button variant="outline" onClick={() => void downloadRender(item.id)}>
        <Download /> {t('download')}
      </Button>
    ) : null;
  if (!item.previewUrl) return null;
  return (
    <Button asChild variant="outline">
      <a href={item.previewUrl} download target="_blank" rel="noopener noreferrer">
        <Download /> {t('download')}
      </a>
    </Button>
  );
}

export function MediaPreviewDialog({
  item,
  onClose,
  returnFocusTo,
}: {
  item: MediaItem | null;
  onClose: () => void;
  /** The tile that opened the dialog: focus goes back to it on close. */
  returnFocusTo?: RefObject<HTMLElement | null>;
}) {
  const t = useTranslations('media.preview');
  const labels = useItemLabels();
  const title = item ? labels.title(item) : '';
  const projectId = item ? projectOfItem(item) : null;

  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl"
        onCloseAutoFocus={(event) => {
          const opener = returnFocusTo?.current;
          if (!opener) return;
          event.preventDefault();
          opener.focus();
        }}
      >
        {item && (
          <>
            <DialogHeader>
              <DialogTitle className="break-words">{title}</DialogTitle>
              <DialogDescription>{labels.type(item)}</DialogDescription>
            </DialogHeader>
            {item.type === 'video' && (
              <RenderPlayer item={item} label={t('playerAria', { title })} />
            )}
            {item.type === 'upload' && item.previewUrl && (
              <video
                src={item.previewUrl}
                controls
                playsInline
                preload="metadata"
                aria-label={t('playerAria', { title })}
                className={PLAYER}
              />
            )}
            {item.type === 'image' && item.previewUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.previewUrl}
                alt={item.altText ?? ''}
                width={item.widthPx}
                height={item.heightPx}
                className="mx-auto block max-h-[60dvh] w-auto max-w-full rounded-lg bg-muted object-contain"
              />
            )}
            <Details item={item} />
            <DialogFooter className="gap-2 sm:justify-between">
              <DownloadAction item={item} />
              {projectId && (
                <Button asChild className="sm:ms-auto">
                  <Link href={`/projects/${projectId}`}>
                    {t('openProject')} <ArrowUpRight className="rtl:-scale-x-100" />
                  </Link>
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
