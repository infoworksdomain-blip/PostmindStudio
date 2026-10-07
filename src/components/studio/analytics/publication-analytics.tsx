'use client';

import Link from 'next/link';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { safeHttpUrl, useFormat, type StudioFormat } from '@/lib/client/format';
import { EmptyState, ErrorState, PageHeader, Section, Stat } from '../primitives';
import { AreaChart, useShortDay } from './area-chart';
import { BarList } from './bar-list';
import type { PublicationAnalyticsResponse } from './types';

// BACKLOG 13.28 — one publication's analytics: totals, views over time, and, where the platform
// reports them (YouTube), the audience-retention curve and the audience by age and gender.
// Reached from the analytics leaderboard.

const YOUTUBE = new Set(['youtube', 'youtube_short']);

/** A 0–100 share as a whole percentage in the active locale (63 → '63%', '٦٣٪', '63 %'). */
const pctText = (f: StudioFormat, v: number) => f.percent(v / 100);

type Slices = PublicationAnalyticsResponse['demographics'];

/** Viewer share per age group (summed over genders), youngest first. */
export function ageBreakdown(slices: Slices): Array<{ ageGroup: string; pct: number }> {
  const byAge = new Map<string, number>();
  for (const s of slices) byAge.set(s.ageGroup, (byAge.get(s.ageGroup) ?? 0) + s.pct);
  return [...byAge.entries()]
    .map(([ageGroup, pct]) => ({ ageGroup, pct: Math.round(pct * 10) / 10 }))
    .sort((a, b) => a.ageGroup.localeCompare(b.ageGroup, 'en', { numeric: true }));
}

/** Viewer share per gender (summed over age groups), largest first. */
export function genderBreakdown(slices: Slices): Array<{ gender: string; pct: number }> {
  const byGender = new Map<string, number>();
  for (const s of slices) byGender.set(s.gender, (byGender.get(s.gender) ?? 0) + s.pct);
  return [...byGender.entries()]
    .map(([gender, pct]) => ({ gender, pct: Math.round(pct * 10) / 10 }))
    .sort((a, b) => b.pct - a.pct);
}

/** audienceWatchRatio at the halfway point, if the curve reaches it. */
export function midpointRetention(
  points: PublicationAnalyticsResponse['retention'],
): number | null {
  const mid = points.find((p) => p.atPct >= 0.5);
  return mid ? mid.watchingPct : null;
}

const GENDERS = ['female', 'male', 'user_specified'] as const;
type Gender = (typeof GENDERS)[number];

function isGender(value: string): value is Gender {
  return (GENDERS as readonly string[]).includes(value);
}

function RetentionSection({ data }: { data: PublicationAnalyticsResponse }) {
  const t = useTranslations('analytics.publication.retention');
  const f = useFormat();
  const youtube = YOUTUBE.has(data.publication.platform);
  const points = data.retention.map((p) => ({
    label: f.percent(p.atPct),
    value: Math.round(p.watchingPct * 1000) / 10,
  }));
  const mid = midpointRetention(data.retention);
  return (
    <Section
      title={t('title')}
      description={mid !== null ? t('midpoint', { pct: pctText(f, mid * 100) }) : t('description')}
    >
      {points.length > 0 ? (
        <AreaChart
          points={points}
          label={t('chartLabel')}
          formatValue={(v) => pctText(f, v)}
          minMax={100}
          pointKind="position"
        />
      ) : (
        <p className="py-6 text-sm text-muted-foreground">
          {youtube
            ? t('youtubePending')
            : t('notReported', { platform: f.platform(data.publication.platform) })}
        </p>
      )}
    </Section>
  );
}

function AudienceSection({ data }: { data: PublicationAnalyticsResponse }) {
  const t = useTranslations('analytics.publication.audience');
  const f = useFormat();
  const ages = ageBreakdown(data.demographics);
  const genders = genderBreakdown(data.demographics);
  const youtube = YOUTUBE.has(data.publication.platform);
  return (
    <Section title={t('title')} description={t('description')}>
      {ages.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">
          {youtube
            ? t('youtubePending')
            : t('notReported', { platform: f.platform(data.publication.platform) })}
        </p>
      ) : (
        <div className="grid gap-6 sm:grid-cols-[1.4fr_1fr]">
          <BarList
            label={t('ageListLabel')}
            empty={t('noAge')}
            rows={ages.map((a) => ({
              key: a.ageGroup,
              label: a.ageGroup,
              value: a.pct,
              display: pctText(f, a.pct),
            }))}
          />
          <BarList
            label={t('genderListLabel')}
            empty={t('noGender')}
            tone="var(--chart-4)"
            rows={genders.map((g) => ({
              key: g.gender,
              label: isGender(g.gender) ? t(`gender.${g.gender}`) : g.gender,
              value: g.pct,
              display: pctText(f, g.pct),
            }))}
          />
        </div>
      )}
    </Section>
  );
}

export function PublicationAnalytics({ publicationId }: { publicationId: string }) {
  const t = useTranslations('analytics.publication');
  const tf = useTranslations('format');
  const f = useFormat();
  const shortDay = useShortDay();
  const { data, error, isLoading, mutate } = useApi<PublicationAnalyticsResponse>(
    `/analytics/publications/${encodeURIComponent(publicationId)}`,
  );
  const platform = data ? f.platform(data.publication.platform) : '';
  const platformUrl = safeHttpUrl(data?.publication.platformUrl);
  const daily = (data?.daily ?? []).map((d) => ({
    label: shortDay(d.at.slice(0, 10)),
    value: d.views,
  }));
  const latest = data?.latest;

  return (
    <>
      <PageHeader
        eyebrow={t('eyebrow')}
        title={data ? t('title', { platform }) : t('titleLoading')}
        description={
          data ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              {t('published', { date: f.date(data.publication.publishedAt) })}
              {platformUrl && (
                <a
                  href={platformUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
                >
                  {t('openOn', { platform })} <ExternalLink className="size-3" />
                </a>
              )}
            </span>
          ) : undefined
        }
        actions={
          <Link
            href="/analytics"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4 rtl:-scale-x-100" /> {t('back')}
          </Link>
        }
      />
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
      {isLoading && <Skeleton aria-label={t('loadingAria')} className="h-64 rounded-xl" />}
      {data && !latest && <EmptyState title={t('empty.title')} description={t('empty.body')} />}
      {data && latest && (
        <div className="grid min-w-0 gap-10">
          <div className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-border/70 py-6 sm:grid-cols-5">
            <Stat label={t('stats.views')} value={f.count(latest.views)} />
            <Stat label={t('stats.watchTime')} value={f.duration(latest.watchTimeSec)} />
            <Stat
              label={t('stats.avgWatched')}
              value={
                latest.avgWatchTimePct !== null
                  ? pctText(f, latest.avgWatchTimePct * 100)
                  : tf('none')
              }
            />
            <Stat label={t('stats.likes')} value={f.count(latest.likes)} />
            <Stat
              label={t('stats.commentsShares')}
              value={t('stats.commentsSharesValue', {
                comments: f.count(latest.comments),
                shares: f.count(latest.shares),
              })}
            />
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
          <div className="grid min-w-0 gap-10 lg:grid-cols-[1.4fr_1fr]">
            <RetentionSection data={data} />
            <AudienceSection data={data} />
          </div>
        </div>
      )}
    </>
  );
}
