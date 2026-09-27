'use client';

import Link from 'next/link';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import {
  formatCount,
  formatDate,
  formatDuration,
  PLATFORM_LABEL,
  safeHttpUrl,
} from '@/lib/client/format';
import { EmptyState, ErrorState, PageHeader, Section, Stat } from '../primitives';
import { AreaChart } from './area-chart';
import { BarList } from './bar-list';
import { shortDay } from './chart-utils';
import type { PublicationAnalyticsResponse } from './types';

// BACKLOG 13.28 — one publication's analytics: totals, views over time, and, where the platform
// reports them (YouTube), the audience-retention curve and the audience by age and gender.
// Reached from the analytics leaderboard.

const YOUTUBE = new Set(['youtube', 'youtube_short']);

const pctText = (v: number) => `${Math.round(v)}%`;

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

const GENDER_LABEL: Record<string, string> = {
  female: 'Female',
  male: 'Male',
  user_specified: 'Self-described',
};

function platformName(platform: string): string {
  return PLATFORM_LABEL[platform] ?? platform;
}

function RetentionSection({ data }: { data: PublicationAnalyticsResponse }) {
  const youtube = YOUTUBE.has(data.publication.platform);
  const points = data.retention.map((p) => ({
    label: `${Math.round(p.atPct * 100)}%`,
    value: Math.round(p.watchingPct * 1000) / 10,
  }));
  const mid = midpointRetention(data.retention);
  return (
    <Section
      title="Audience retention"
      description={
        mid !== null
          ? `${pctText(mid * 100)} of viewers still watching halfway through`
          : 'How much of the video people watched'
      }
    >
      {points.length > 0 ? (
        <AreaChart
          points={points}
          label="Viewers still watching, by how far into the video"
          formatValue={pctText}
          minMax={100}
          pointName="point in the video"
        />
      ) : (
        <p className="py-6 text-sm text-muted-foreground">
          {youtube
            ? 'YouTube reports retention about a day after publishing. Check back tomorrow.'
            : `${platformName(data.publication.platform)} does not report a retention curve.`}
        </p>
      )}
    </Section>
  );
}

function AudienceSection({ data }: { data: PublicationAnalyticsResponse }) {
  const ages = ageBreakdown(data.demographics);
  const genders = genderBreakdown(data.demographics);
  const youtube = YOUTUBE.has(data.publication.platform);
  return (
    <Section title="Audience" description="Share of viewers by age and gender">
      {ages.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">
          {youtube
            ? 'YouTube shows audience data once enough people have watched.'
            : `${platformName(data.publication.platform)} does not report audience demographics.`}
        </p>
      ) : (
        <div className="grid gap-6 sm:grid-cols-[1.4fr_1fr]">
          <BarList
            label="Viewers by age group"
            empty="No age data."
            rows={ages.map((a) => ({
              key: a.ageGroup,
              label: a.ageGroup,
              value: a.pct,
              display: pctText(a.pct),
            }))}
          />
          <BarList
            label="Viewers by gender"
            empty="No gender data."
            tone="var(--chart-4)"
            rows={genders.map((g) => ({
              key: g.gender,
              label: GENDER_LABEL[g.gender] ?? g.gender,
              value: g.pct,
              display: pctText(g.pct),
            }))}
          />
        </div>
      )}
    </Section>
  );
}

export function PublicationAnalytics({ publicationId }: { publicationId: string }) {
  const { data, error, isLoading, mutate } = useApi<PublicationAnalyticsResponse>(
    `/analytics/publications/${encodeURIComponent(publicationId)}`,
  );
  const platform = data ? platformName(data.publication.platform) : '';
  const platformUrl = safeHttpUrl(data?.publication.platformUrl);
  const daily = (data?.daily ?? []).map((d) => ({
    label: shortDay(d.at.slice(0, 10)),
    value: d.views,
  }));
  const latest = data?.latest;

  return (
    <>
      <PageHeader
        eyebrow="Analytics"
        title={data ? `${platform} post` : 'Publication'}
        description={
          data ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              Published {formatDate(data.publication.publishedAt)}
              {platformUrl && (
                <a
                  href={platformUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
                >
                  Open on {platform} <ExternalLink className="size-3" />
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
            <ArrowLeft className="size-4" /> All analytics
          </Link>
        }
      />
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {isLoading && (
        <Skeleton aria-label="Loading publication analytics" className="h-64 rounded-xl" />
      )}
      {data && !latest && (
        <EmptyState
          title="No numbers yet"
          description="Studio starts reading this post's metrics a few minutes after it goes live."
        />
      )}
      {data && latest && (
        <div className="grid min-w-0 gap-6">
          <div className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-border/70 py-6 sm:grid-cols-5">
            <Stat label="Views" value={formatCount(latest.views)} />
            <Stat label="Watch time" value={formatDuration(latest.watchTimeSec)} />
            <Stat
              label="Avg. watched"
              value={latest.avgWatchTimePct !== null ? pctText(latest.avgWatchTimePct * 100) : '—'}
            />
            <Stat label="Likes" value={formatCount(latest.likes)} />
            <Stat
              label="Comments · shares"
              value={`${formatCount(latest.comments)} · ${formatCount(latest.shares)}`}
            />
          </div>
          <Section title="Views over time" description="Total views at the end of each day">
            {daily.length > 1 ? (
              <AreaChart points={daily} label="Total views by day" formatValue={formatCount} />
            ) : (
              <p className="py-6 text-sm text-muted-foreground">
                A daily chart appears after the second day.
              </p>
            )}
          </Section>
          <div className="grid min-w-0 gap-6 lg:grid-cols-[1.4fr_1fr]">
            <RetentionSection data={data} />
            <AudienceSection data={data} />
          </div>
        </div>
      )}
    </>
  );
}
