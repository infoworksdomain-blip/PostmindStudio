'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { mediaAspect } from '@/components/ui/media-tile';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { EmptyState, ErrorState } from '../primitives';
import { BlueprintTimeline } from './blueprint-timeline';
import { useAnalysisLabels } from './analysis-labels';
import { SimilarShelf } from './similar-shelf';
import type { BlueprintResponse, LibraryVideoDetail } from './types';
import { UseReferencePanel } from './use-reference-panel';

// BACKLOG 10.7, redesigned in 25.10 (a large player on a matte stage beside the facts and the
// "Use as reference" actions) — one reference video: preview, metadata, analysed structure (the
// TEMPLATE blueprint when the licence allows it, otherwise only the INSPIRE style signature),
// similar videos and "Use as reference".
// BACKLOG 20.17 (operator decision 2026-10-01): the preview has sound. It is not muted and never
// autoplays (browsers block autoplay with sound anyway); it plays with sound when the user
// presses play. Hover previews on cards (video-card.tsx) stay muted. Still no download: the
// browser's download control is hidden and the signed URL lives 10 minutes (A3.10).

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('mt-0.5 truncate text-sm font-medium', mono && 'font-mono')}>{value}</dd>
    </div>
  );
}

function StructureSection({ id }: { id: string }) {
  const t = useTranslations('library.structure');
  const tf = useTranslations('library.detail.facts');
  const td = useTranslations('library.detail');
  const none = useTranslations('format')('none');
  const f = useFormat();
  const labels = useAnalysisLabels();
  const { data, error, isLoading } = useApi<BlueprintResponse>(`/library/blueprint/${id}`);
  let body;
  if (isLoading) body = <Skeleton className="h-40 rounded-xl" />;
  else if (error instanceof ApiError && error.status === 404)
    body = <p className="text-sm text-muted-foreground">{t('notAnalysed')}</p>;
  else if (error) body = <ErrorState error={error} />;
  else if (data) {
    const s = data.styleSignature;
    body = (
      <div className="grid gap-8 lg:grid-cols-[1fr_16rem]">
        <div className="min-w-0">
          {data.blueprint ? (
            <BlueprintTimeline blueprint={data.blueprint} />
          ) : (
            <p className="border-s-2 border-border-strong py-1 ps-4 text-sm text-muted-foreground">
              {t('inspireOnly')}
            </p>
          )}
        </div>
        <dl className="grid content-start gap-3 border-t border-border pt-4 lg:border-t-0 lg:border-s lg:pt-0 lg:ps-6">
          <Fact label={tf('pace')} value={labels.pace(s.paceTag)} />
          <Fact label={tf('mood')} value={s.moodTag} />
          <Fact label={tf('structure')} value={s.structurePattern} />
          <Fact label={tf('music')} value={s.musicGenreTag ?? none} />
          {data.blueprint && (
            <>
              <Fact label={tf('hook')} value={data.blueprint.hookPattern} />
              <Fact label={tf('callToAction')} value={data.blueprint.ctaPattern ?? none} />
              <Fact
                label={tf('musicEnvelope')}
                value={
                  [
                    data.blueprint.musicEnvelope.bpm &&
                      td('bpm', { bpm: f.number(data.blueprint.musicEnvelope.bpm) }),
                    data.blueprint.musicEnvelope.energy,
                  ]
                    .filter(Boolean)
                    .join(' · ') || none
                }
              />
            </>
          )}
        </dl>
      </div>
    );
  }
  return (
    <section aria-labelledby="library-structure" className="min-w-0">
      <h2 id="library-structure" className="mb-4 text-lg font-semibold tracking-tight">
        {t('heading')}
      </h2>
      {body}
    </section>
  );
}

export function LibraryDetail({ id }: { id: string }) {
  const t = useTranslations('library.detail');
  const tf = useTranslations('library.detail.facts');
  const none = useTranslations('format')('none');
  const f = useFormat();
  const labels = useAnalysisLabels();
  const { data, error, isLoading, mutate } = useApi<{ ok: true; video: LibraryVideoDetail }>(
    `/library/videos/${id}`,
  );
  const back = (
    <Link
      href="/library"
      className="mb-6 inline-flex items-center gap-1.5 rounded-control text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeft className="size-4 rtl:-scale-x-100" /> {t('back')}
    </Link>
  );

  if (error instanceof ApiError && error.status === 404) {
    return (
      <>
        {back}
        <EmptyState title={t('notFoundTitle')} description={t('notFoundBody')} />
      </>
    );
  }
  if (error)
    return (
      <>
        {back}
        <ErrorState error={error} onRetry={() => void mutate()} />
      </>
    );
  if (isLoading || !data)
    return (
      <div aria-label={t('loading')} className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Skeleton className="h-[min(72dvh,680px)] rounded-panel" />
        <Skeleton className="h-64 rounded-panel" />
      </div>
    );

  const video = data.video;
  const landscape = mediaAspect(video.aspectRatio) === '16:9';
  return (
    <>
      {back}
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-12">
        {/* The stage: the player is the largest thing on the page, on a quiet matte. */}
        <figure className="m-0 min-w-0">
          <div className="grid place-items-center rounded-panel bg-surface-raised p-3 sm:p-6 dark:bg-black/50">
            <video
              src={video.previewUrl}
              poster={video.thumbnailUrl}
              loop
              playsInline
              controls
              controlsList="nodownload"
              disablePictureInPicture
              onContextMenu={(e) => e.preventDefault()}
              preload="metadata"
              aria-label={t('previewAria', { title: video.title })}
              className={cn(
                'block max-w-full rounded-lg bg-black object-contain shadow-overlay',
                landscape ? 'aspect-video w-full' : 'aspect-[9/16] h-[min(72dvh,680px)] w-auto',
              )}
            />
          </div>
          <figcaption className="mt-2 text-center text-xs text-muted-foreground">
            {t('previewNote', { minutes: Math.round(video.previewExpiresInSec / 60) })}
          </figcaption>
        </figure>
        <div className="min-w-0">
          <p className="mb-2 text-xs font-medium text-muted-foreground">{video.category.name}</p>
          <h1 className="font-display text-[1.75rem] leading-[1.1] break-words md:text-[2.25rem]">
            {video.title}
          </h1>
          {video.description && (
            <p className="mt-3 text-[0.9375rem] leading-relaxed text-foreground-secondary">
              {video.description}
            </p>
          )}
          <dl className="mt-6 grid grid-cols-2 gap-4 border-y border-border py-4">
            <Fact label={tf('length')} value={f.duration(video.durationSec)} mono />
            <Fact label={tf('aspect')} value={video.aspectRatio} mono />
            <Fact
              label={tf('shots')}
              value={video.analysis ? f.number(video.analysis.shotCount) : none}
              mono
            />
            <Fact label={tf('pace')} value={labels.pace(video.analysis?.paceTag)} />
          </dl>
          {video.tags.length > 0 && (
            <ul aria-label={t('tagsAria')} className="mt-4 flex flex-wrap gap-1.5">
              {video.tags.map((tag) => (
                <li
                  key={tag}
                  className="rounded-full bg-surface-raised px-2.5 py-0.5 text-xs text-foreground-secondary"
                >
                  {tag}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-8">
            <UseReferencePanel id={video.id} allowedModes={video.allowedModes} />
          </div>
        </div>
      </div>
      <div className="mt-rhythm-section grid gap-rhythm-section">
        <StructureSection id={video.id} />
        <SimilarShelf id={video.id} />
      </div>
    </>
  );
}
