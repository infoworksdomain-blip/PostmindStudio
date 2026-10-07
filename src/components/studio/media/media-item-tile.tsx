'use client';

import { FileVideo } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { MediaTile } from '@/components/ui/media-tile';
import { StatusPill } from '@/components/ui/status-pill';
import { useFormat, type Tone } from '@/lib/client/format';
import { durationOfItem, posterOfItem, sizeOfItem } from './media-model';
import type { MediaItem } from './types';

// One item of My media as a MediaTile in a mixed grid: every tile has the same 4:5 frame and the
// media sits inside it at its own shape (letterboxed on a quiet matte), so a row of 9:16, 16:9
// and square items still lines up. The pill says what it is (a video's review state, an upload's
// kind, an image's source); uploads have no still, so they preview the file itself on hover.

export interface ItemLabels {
  title: (item: MediaItem) => string;
  type: (item: MediaItem) => string;
  pill: (item: MediaItem) => { label: string; tone: Tone };
}

export function useItemLabels(): ItemLabels {
  const t = useTranslations('media');
  const f = useFormat();
  return {
    title: (item) =>
      item.type === 'image' ? item.altText || t('untitledImage') : item.title || t('untitledVideo'),
    type: (item) => t(`type.${item.type}`),
    pill: (item) => {
      if (item.type === 'video') return f.projectState(item.projectState);
      if (item.type === 'upload') return { label: t(`uploadKind.${item.kind}`), tone: 'neutral' };
      return { label: t(`imageSource.${item.source}`), tone: 'neutral' };
    },
  };
}

function UploadPreview({ src }: { src: string }) {
  return (
    <video
      data-testid="upload-hover-preview"
      src={src}
      muted
      autoPlay
      loop
      playsInline
      aria-hidden
      className="absolute inset-0 size-full object-contain"
    />
  );
}

export function MediaItemTile({ item, onOpen }: { item: MediaItem; onOpen: () => void }) {
  const f = useFormat();
  const labels = useItemLabels();
  const pill = labels.pill(item);
  const duration = durationOfItem(item);
  const size = sizeOfItem(item);
  return (
    <MediaTile
      onSelect={onOpen}
      title={labels.title(item)}
      meta={`${labels.type(item)} · ${f.relative(item.createdAt)}`}
      posterUrl={posterOfItem(item)}
      posterWidth={size?.width}
      posterHeight={size?.height}
      aspect="4:5"
      fit="contain"
      kind={item.type === 'image' ? 'image' : 'video'}
      duration={duration ? f.duration(duration) : undefined}
      pill={
        <StatusPill size="sm" tone={pill.tone}>
          {pill.label}
        </StatusPill>
      }
      fallback={<FileVideo className="size-8 text-muted-foreground" strokeWidth={1.5} />}
      renderPreview={
        item.type === 'upload' && item.previewUrl
          ? () => <UploadPreview src={item.previewUrl} />
          : undefined
      }
    />
  );
}
