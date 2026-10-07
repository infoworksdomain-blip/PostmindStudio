'use client';

import dynamic from 'next/dynamic';
import { useLocale, useTranslations } from 'next-intl';
import { ImageOff } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { LOCALE_INFO, type Locale } from '@/lib/i18n/locales';
import type { PostPreview } from '@/lib/studio/services/post-preview';
import { ASPECT_SIZE, hasPreview } from './preview-model';

// 24.2 — the side panel's instant preview. The Remotion Player is a client-only dynamic import
// (next/dynamic, ssr: false): its chunk loads the first time a panel opens, never with the
// calendar, plan or Blitz page bundles.

const RemotionPreview = dynamic(() => import('./remotion-player'), {
  ssr: false,
  loading: () => <Skeleton className="aspect-[9/16] w-full rounded-lg" />,
});

export function PostPreviewPlayer({ preview }: { preview: PostPreview }) {
  const t = useTranslations('calendar.panel.preview');
  const locale = useLocale();
  const size = ASPECT_SIZE[preview.aspectRatio];
  if (!hasPreview(preview.media))
    return (
      <div
        className="grid place-items-center gap-2 rounded-lg border border-dashed border-border bg-muted/40 p-6 text-center text-sm text-muted-foreground"
        style={{ aspectRatio: `${size.width} / ${size.height}` }}
      >
        <ImageOff aria-hidden className="size-6" />
        {t('nothingYet')}
      </div>
    );
  return (
    <RemotionPreview
      aspect={preview.aspectRatio}
      label={t('aria', { kind: t(`kind.${preview.media.kind}`) })}
      composition={{
        media: preview.media,
        caption: preview.caption,
        dir: LOCALE_INFO[locale as Locale]?.dir ?? 'ltr',
        labels: {
          storyboard: t('storyboard'),
          shot: (n, total) => t('shot', { n, total }),
        },
      }}
    />
  );
}
