'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, useApi } from '@/lib/client/api';
import { formatDuration } from '@/lib/client/format';
import { EmptyState, ErrorState } from '../primitives';
import { BlueprintTimeline } from './blueprint-timeline';
import { humanise } from './library-utils';
import { SimilarShelf } from './similar-shelf';
import type { BlueprintResponse, LibraryVideoDetail } from './types';
import { UseReferencePanel } from './use-reference-panel';

// BACKLOG 10.7 — one reference video: muted preview, metadata, analysed structure (the
// TEMPLATE blueprint when the licence allows it, otherwise only the INSPIRE style signature),
// similar videos and "Use as reference".

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium">{value}</dd>
    </div>
  );
}

function StructureSection({ id }: { id: string }) {
  const { data, error, isLoading } = useApi<BlueprintResponse>(`/library/blueprint/${id}`);
  let body;
  if (isLoading) body = <Skeleton className="h-40 rounded-xl" />;
  else if (error instanceof ApiError && error.status === 404)
    body = <p className="text-sm text-muted-foreground">This video hasn’t been analysed yet.</p>;
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
              Inspire-only reference: its shot-by-shot structure isn’t used, only the style tags
              alongside.
            </p>
          )}
        </div>
        <dl className="grid content-start gap-3 border-t border-border pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
          <Fact label="Pace" value={humanise(s.paceTag)} />
          <Fact label="Mood" value={s.moodTag} />
          <Fact label="Structure" value={s.structurePattern} />
          <Fact label="Music" value={s.musicGenreTag ?? '—'} />
          {data.blueprint && (
            <>
              <Fact label="Hook" value={data.blueprint.hookPattern} />
              <Fact label="Call to action" value={data.blueprint.ctaPattern ?? '—'} />
              <Fact
                label="Music envelope"
                value={
                  [
                    data.blueprint.musicEnvelope.bpm && `${data.blueprint.musicEnvelope.bpm} bpm`,
                    data.blueprint.musicEnvelope.energy,
                  ]
                    .filter(Boolean)
                    .join(' · ') || '—'
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
        How it’s built
      </h2>
      {body}
    </section>
  );
}

export function LibraryDetail({ id }: { id: string }) {
  const { data, error, isLoading, mutate } = useApi<{ ok: true; video: LibraryVideoDetail }>(
    `/library/videos/${id}`,
  );
  const back = (
    <Link
      href="/library"
      className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" /> Reference library
    </Link>
  );

  if (error instanceof ApiError && error.status === 404) {
    return (
      <>
        {back}
        <EmptyState
          title="Reference not found"
          description="It may have been retired from the library."
        />
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
      <div aria-label="Loading reference" className="grid gap-6 md:grid-cols-[18rem_1fr]">
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
            muted
            loop
            playsInline
            controls
            preload="metadata"
            aria-label={`Muted preview of ${video.title}`}
            className="aspect-[9/16] w-full rounded-2xl bg-secondary object-cover shadow-[0_24px_48px_-24px_rgb(0_0_0/0.35)]"
          />
          <p className="mt-2 text-center text-xs text-muted-foreground">
            Low-res preview · link expires in {Math.round(video.previewExpiresInSec / 60)} min
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
            <Fact label="Length" value={formatDuration(video.durationSec)} />
            <Fact label="Aspect" value={video.aspectRatio} />
            <Fact label="Shots" value={String(video.analysis?.shotCount ?? '—')} />
            <Fact label="Pace" value={humanise(video.analysis?.paceTag)} />
          </dl>
          {video.tags.length > 0 && (
            <ul aria-label="Tags" className="mt-4 flex flex-wrap gap-1.5">
              {video.tags.map((t) => (
                <li key={t} className="rounded-full bg-secondary px-2.5 py-0.5 text-xs">
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
