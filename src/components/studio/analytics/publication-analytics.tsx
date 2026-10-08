'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { safeHttpUrl, useFormat } from '@/lib/client/format';
import { EmptyState, ErrorState, PageHeader, Section } from '../primitives';
import { AreaChart, useShortDay } from './area-chart';
import { PostThumbnail } from './post-thumbnail';
import { AudienceSection, pctText, RetentionSection } from './publication-sections';
import type { PublicationAnalyticsResponse } from './types';

// BACKLOG 13.28 / 25.11 — one publication's analytics, in the same system as the dashboard: the
// post (its poster frame and caption) beside the key numbers, views over time, and, where the
// platform reports them (YouTube), the audience-retention curve and the audience by age and
// gender. Reached from the dashboard's top posts.

export { ageBreakdown, genderBreakdown, midpointRetention } from './publication-sections';

type Latest = NonNullable<PublicationAnalyticsResponse['latest']>;

function KeyNumber({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-2 font-display text-3xl leading-none tracking-tight md:text-4xl">
        {value}
      </dd>
    </div>
  );
}

function KeyNumbers({ latest }: { latest: Latest }) {
  const t = useTranslations('analytics.publication');
  const tf = useTranslations('format');
  const f = useFormat();
  return (
    <dl className="grid min-w-0 grid-cols-2 content-center gap-x-6 gap-y-6 sm:grid-cols-3">
      <KeyNumber label={t('stats.views')} value={f.count(latest.views)} />
      <KeyNumber label={t('stats.watchTime')} value={f.duration(latest.watchTimeSec)} />
      <KeyNumber
        label={t('stats.avgWatched')}
        value={
          latest.avgWatchTimePct !== null ? pctText(f, latest.avgWatchTimePct * 100) : tf('none')
        }
      />
      <KeyNumber label={t('stats.likes')} value={f.count(latest.likes)} />
      <KeyNumber
        label={t('stats.commentsShares')}
        value={t('stats.commentsSharesValue', {
          comments: f.count(latest.comments),
          shares: f.count(latest.shares),
        })}
      />
      <KeyNumber label={t('stats.saves')} value={f.count(latest.saves)} />
    </dl>
  );
}

/** Same footprint as the loaded page: poster, six numbers, then a chart. */
function PublicationSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy aria-label={label} className="grid gap-12">
      <div className="grid gap-8 border-t border-border pt-6 sm:grid-cols-[8rem_1fr]">
        <Skeleton className="aspect-[9/16] w-24 rounded-field sm:w-32" />
        <div className="grid grid-cols-2 content-center gap-6 sm:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i}>
              <Skeleton className="h-3 w-16" />
              <Skeleton className="mt-3 h-9 w-24" />
            </div>
          ))}
        </div>
      </div>
      <Skeleton className="h-[226px] rounded-field" />
    </div>
  );
}

function Header({ data }: { data?: PublicationAnalyticsResponse }) {
  const t = useTranslations('analytics.publication');
  const f = useFormat();
  const platform = data ? f.platform(data.publication.platform) : '';
  const platformUrl = safeHttpUrl(data?.publication.platformUrl);
  const caption = data?.publication.caption?.trim();
  return (
    <PageHeader
      eyebrow={t('eyebrow')}
      title={data ? t('title', { platform }) : t('titleLoading')}
      description={
        data ? (
          <>
            {caption && <span className="mb-1 line-clamp-2 block text-foreground">{caption}</span>}
            <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
              {t('published', { date: f.date(data.publication.publishedAt) })}
              {platformUrl && (
                <a
                  href={platformUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
                >
                  {t('openOn', { platform })} <ExternalLink aria-hidden className="size-3" />
                </a>
              )}
            </span>
          </>
        ) : undefined
      }
      actions={
        <Link
          href="/analytics"
          className="inline-flex items-center gap-1 rounded-control text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="size-4 rtl:-scale-x-100" /> {t('back')}
        </Link>
      }
    />
  );
}

export function PublicationAnalytics({ publicationId }: { publicationId: string }) {
  const t = useTranslations('analytics.publication');
  const f = useFormat();
  const shortDay = useShortDay();
  const { data, error, isLoading, mutate } = useApi<PublicationAnalyticsResponse>(
    `/analytics/publications/${encodeURIComponent(publicationId)}`,
  );
  const daily = (data?.daily ?? []).map((d) => ({
    label: shortDay(d.at.slice(0, 10)),
    value: d.views,
  }));
  const latest = data?.latest;

  return (
    <>
      <Header data={data} />
      {error && (
        <ErrorState
          error={error}
          onRetry={() => void mutate()}
          notFound={{
            title: t('notFound.title'),
            body: t('notFound.body'),
            href: '/analytics',
            action: t('notFound.action'),
          }}
        />
      )}
      {isLoading && <PublicationSkeleton label={t('loadingAria')} />}
      {data && !latest && (
        <EmptyState media="publications" title={t('empty.title')} description={t('empty.body')} />
      )}
      {data && latest && (
        <div className="grid min-w-0 gap-12">
          <div className="grid items-center gap-8 border-t border-border pt-6 sm:grid-cols-[8rem_1fr]">
            <PostThumbnail
              renderId={data.publication.renderId}
              className="w-24 rounded-field shadow-raised sm:w-32"
            />
            <KeyNumbers latest={latest} />
          </div>
          <Section title={t('viewsOverTime.title')} description={t('viewsOverTime.description')}>
            {daily.length > 1 ? (
              <AreaChart
                points={daily}
                label={t('viewsOverTime.chartLabel')}
                formatValue={f.count}
              />
            ) : (
              <p className="py-6 text-sm text-muted-foreground">{t('viewsOverTime.tooFew')}</p>
            )}
          </Section>
          <div className="grid min-w-0 gap-12 lg:grid-cols-[1.4fr_1fr] lg:gap-10">
            <RetentionSection data={data} />
            <AudienceSection data={data} />
          </div>
        </div>
      )}
    </>
  );
}
