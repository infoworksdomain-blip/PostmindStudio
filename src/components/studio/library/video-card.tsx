'use client';

import { useTranslations } from 'next-intl';
import { MediaTile, mediaAspect } from '@/components/ui/media-tile';
import { StatusPill } from '@/components/ui/status-pill';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { useAnalysisLabels } from './analysis-labels';
import type { LibraryVideoDetail, LibraryVideoSummary } from './types';
import { EmptyIllustration } from '../empty-illustration';

// One reference video as a MediaTile (25.10). List results carry only a thumbnail (A3.10: the
// preview rendition is signed per detail request), so hovering / focusing for a moment fetches
// the detail and plays its low-res preview in place, muted (the detail player has sound, 20.17).

function HoverPreview({ id }: { id: string }) {
  const { data } = useApi<{ ok: true; video: LibraryVideoDetail }>(`/library/videos/${id}`);
  const url = data?.video.previewUrl;
  if (!url) return null;
  return (
    <video
      data-testid="hover-preview"
      src={url}
      muted
      autoPlay
      loop
      playsInline
      aria-hidden
      className="absolute inset-0 size-full object-cover"
    />
  );
}

export function VideoCard({
  video,
  className,
}: {
  video: LibraryVideoSummary;
  className?: string;
}) {
  const t = useTranslations('library.card');
  const f = useFormat();
  const labels = useAnalysisLabels();
  const templateAllowed = video.allowedModes.includes('TEMPLATE');
  const meta = [
    video.category.name,
    video.analysis && labels.pace(video.analysis.paceTag),
    video.analysis?.moodTag,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <MediaTile
      href={`/library/${video.id}`}
      title={video.title}
      meta={meta}
      posterUrl={video.thumbnailUrl || null}
      aspect={mediaAspect(video.aspectRatio)}
      kind="video"
      duration={f.duration(video.durationSec)}
      pill={
        <StatusPill size="sm" tone={templateAllowed ? 'info' : 'neutral'}>
          {templateAllowed ? t('templateAndInspire') : t('inspireOnly')}
        </StatusPill>
      }
      corner={
        typeof video.similarity === 'number' ? (
          <StatusPill size="sm" className="font-mono">
            {t('match', { percent: f.percent(video.similarity) })}
          </StatusPill>
        ) : undefined
      }
      fallback={<EmptyIllustration name="library" className="h-auto w-4/5" />}
      renderPreview={() => <HoverPreview id={video.id} />}
      className={className}
    />
  );
}
