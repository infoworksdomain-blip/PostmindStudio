'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { EmptyState, ErrorState } from '../primitives';
import { BlueprintTimeline } from './blueprint-timeline';
import { useAnalysisLabels } from './analysis-labels';
import { SimilarShelf } from './similar-shelf';
import type { BlueprintResponse, LibraryVideoDetail } from './types';
import { UseReferencePanel } from './use-reference-panel';

// BACKLOG 10.7 — one reference video: preview, metadata, analysed structure (the
// TEMPLATE blueprint when the licence allows it, otherwise only the INSPIRE style signature),
// similar videos and "Use as reference".
// BACKLOG 20.17 (operator decision 2026-10-01): the preview has sound. It is not muted and never
// autoplays (browsers block autoplay with sound anyway); it plays with sound when the user
// presses play. Hover previews on cards (video-card.tsx) stay muted. Still no download: the
// browser's download control is hidden and the signed URL lives 10 minutes (A3.10).

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium">{value}</dd>
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
            <p className="rounded-xl border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">
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
      <h2 id="library-structure" className="mb-4 font-display text-2xl">
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
      className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
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
      <div aria-label={t('loading')} className="grid gap-6 md:grid-cols-[18rem_1fr]">
        <Skeleton className="aspect-[9/16] rounded-2xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );

  const video = data.video;
  return (
    <>
      {back}
      <div className="grid gap-8 md:grid-cols-[minmax(0,18rem)_1fr] md:gap-12">
        <div className="mx-auto w-full max-w-[18rem]">
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
            className="aspect-[9/16] w-full rounded-2xl bg-secondary object-cover shadow-[0_24px_48px_-24px_rgb(0_0_0/0.35)]"
          />
          <p className="mt-2 text-center text-xs text-muted-foreground">
            {t('previewNote', { minutes: Math.round(video.previewExpiresInSec / 60) })}
          </p>
        </div>
        <div className="min-w-0">
          <p className="mb-2 text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
            {video.category.name}
          </p>
          <h1 className="font-display text-4xl leading-none break-words md:text-5xl">
            {video.title}
          </h1>
          {video.description && (
            <p className="mt-4 max-w-prose text-sm text-muted-foreground">{video.description}</p>
          )}
          <dl className="mt-6 grid grid-cols-2 gap-4 border-y border-border/70 py-4 sm:grid-cols-4">
            <Fact label={tf('length')} value={f.duration(video.durationSec)} />
            <Fact label={tf('aspect')} value={video.aspectRatio} />
            <Fact
              label={tf('shots')}
              value={video.analysis ? f.number(video.analysis.shotCount) : none}
            />
            <Fact label={tf('pace')} value={labels.pace(video.analysis?.paceTag)} />
          </dl>
          {video.tags.length > 0 && (
            <ul aria-label={t('tagsAria')} className="mt-4 flex flex-wrap gap-1.5">
              {video.tags.map((t) => (
                <li
                  key={t}
                  className="rounded-full bg-surface-raised px-2.5 py-0.5 text-xs text-foreground-secondary"
                >
                  {t}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-8 max-w-md">
            <UseReferencePanel id={video.id} allowedModes={video.allowedModes} />
          </div>
        </div>
      </div>
      <div className="mt-14 grid gap-14">
        <StructureSection id={video.id} />
        <SimilarShelf id={video.id} />
      </div>
    </>
  );
}
