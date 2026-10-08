'use client';

import Link from 'next/link';
import { ChevronRight, ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { safeHttpUrl, useFormat } from '@/lib/client/format';
import { ErrorState, Section } from '../primitives';
import { BarList } from './bar-list';
import { PostThumbnail } from './post-thumbnail';
import type { LeaderboardEntry, LeaderboardResponse, OverviewResponse } from './types';

// BACKLOG 25.11 — content performance (the period's top posts by views, each opening its own
// analytics) and the platform comparison (views per platform from the overview).

export const TOP_POSTS = 6;

export function PlatformBreakdown({ overview }: { overview?: OverviewResponse }) {
  const t = useTranslations('analytics.platforms');
  const f = useFormat();
  const rows = Object.entries(overview?.byPlatform ?? {})
    .map(([platform, v]) => ({
      key: platform,
      label: f.platform(platform),
      value: v.views,
      display: f.count(v.views),
      hint: t('hint', { posts: v.publications, engagement: f.count(v.engagement) }),
    }))
    .sort((a, b) => b.value - a.value);
  return (
    <Section title={t('title')} description={t('description')}>
      {overview ? (
        <BarList rows={rows} label={t('listLabel')} empty={t('empty')} />
      ) : (
        <Skeleton className="h-40 rounded-field" />
      )}
    </Section>
  );
}

function PostRow({ post, rank }: { post: LeaderboardEntry; rank: number }) {
  const t = useTranslations('analytics.leaderboard');
  const f = useFormat();
  const platformUrl = safeHttpUrl(post.platformUrl);
  const platform = f.platform(post.platform);
  const caption = post.caption?.trim();
  return (
    <li className="group relative grid grid-cols-[1.25rem_2rem_1fr_auto] items-center gap-3 py-3">
      <span className="font-mono text-sm text-muted-foreground">{f.number(rank)}</span>
      <PostThumbnail renderId={post.renderId} className="w-8 rounded-control" />
      <span className="min-w-0">
        {/* 13.28: each post opens its own analytics (retention, audience). */}
        <Link
          href={`/analytics/publications/${post.id}`}
          aria-label={caption ? t('analyticsFor', { caption }) : t('analyticsForUntitled')}
          className="block truncate text-sm font-medium underline-offset-2 after:absolute after:inset-0 after:rounded-field hover:underline focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
        >
          {caption || t('untitled')}
        </Link>
        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          {t('meta', { platform, date: f.date(post.publishedAt, { dateStyle: 'medium' }) })}
          {platformUrl && (
            <a
              href={platformUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('openOn', { platform })}
              className="relative z-(--z-raised) inline-grid size-6 place-items-center rounded-control hover:bg-secondary hover:text-foreground"
            >
              <ExternalLink aria-hidden className="size-3" />
            </a>
          )}
        </span>
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="text-end">
          <span className="block font-mono text-sm font-medium">{f.count(post.value)}</span>
          <span className="block text-[0.6875rem] text-muted-foreground">{t('views')}</span>
        </span>
        <ChevronRight
          aria-hidden
          className="size-4 text-muted-foreground transition-transform duration-(--duration-fast) group-hover:translate-x-0.5 motion-reduce:transition-none rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5"
        />
      </span>
    </li>
  );
}

export function ContentPerformance({
  days,
  businessId,
}: {
  days: number;
  businessId: string | null;
}) {
  const t = useTranslations('analytics.leaderboard');
  const { data, error, isLoading, mutate } = useApi<LeaderboardResponse>(
    '/analytics/leaderboard',
    { days, metric: 'views', limit: TOP_POSTS, ...(businessId && { businessId }) },
    { keepPreviousData: true },
  );
  return (
    <Section title={t('title')} description={t('description')}>
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {isLoading && !data && <Skeleton className="h-[30rem] rounded-field" />}
      {data && data.data.length === 0 && (
        <p className="py-6 text-sm text-muted-foreground">{t('empty')}</p>
      )}
      {data && data.data.length > 0 && (
        <ol aria-label={t('listLabel')} className="divide-y divide-border">
          {data.data.map((p, i) => (
            <PostRow key={p.id} post={p} rank={i + 1} />
          ))}
        </ol>
      )}
    </Section>
  );
}
