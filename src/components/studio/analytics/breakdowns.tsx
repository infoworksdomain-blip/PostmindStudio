'use client';

import Link from 'next/link';
import { ChevronRight, ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { safeHttpUrl, useFormat } from '@/lib/client/format';
import { ErrorState, Section } from '../primitives';
import { BarList } from './bar-list';
import type { LeaderboardResponse, OverviewResponse } from './types';

// Per-platform breakdown (from the overview) and the leaderboard of top publications
// (spec 14.3 "leaderboard of best-performing videos").

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
        <Skeleton className="h-32 rounded-lg" />
      )}
    </Section>
  );
}

export function Leaderboard({ days }: { days: number }) {
  const t = useTranslations('analytics.leaderboard');
  const f = useFormat();
  const { data, error, isLoading, mutate } = useApi<LeaderboardResponse>('/analytics/leaderboard', {
    days,
    metric: 'views',
    limit: 10,
  });
  return (
    <Section title={t('title')} description={t('description')}>
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {isLoading && <Skeleton className="h-48 rounded-lg" />}
      {data && data.data.length === 0 && (
        <p className="py-6 text-sm text-muted-foreground">{t('empty')}</p>
      )}
      {data && data.data.length > 0 && (
        <ol aria-label={t('listLabel')} className="divide-y divide-border/70">
          {data.data.map((p, i) => {
            const platformUrl = safeHttpUrl(p.platformUrl);
            const platform = f.platform(p.platform);
            const caption = p.caption?.trim();
            return (
              <li key={p.id} className="grid grid-cols-[1.5rem_1fr_auto] items-center gap-3 py-2.5">
                <span className="tabular font-display text-xl text-muted-foreground">
                  {f.number(i + 1)}
                </span>
                <span className="min-w-0">
                  <Link
                    href={`/projects/${p.projectId}`}
                    className="block truncate text-sm font-medium hover:underline"
                  >
                    {caption || t('untitled')}
                  </Link>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {t('meta', { platform, date: f.date(p.publishedAt) })}
                    {platformUrl && (
                      <a
                        href={platformUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={t('openOn', { platform })}
                        className="hover:text-foreground"
                      >
                        <ExternalLink className="size-3" />
                      </a>
                    )}
                  </span>
                </span>
                {/* 13.28: per-publication analytics (retention, audience). */}
                <Link
                  href={`/analytics/publications/${p.id}`}
                  aria-label={caption ? t('analyticsFor', { caption }) : t('analyticsForUntitled')}
                  className="tabular inline-flex items-center gap-1 text-sm font-medium hover:underline"
                >
                  {f.count(p.value)}
                  <ChevronRight className="size-3.5 text-muted-foreground rtl:-scale-x-100" />
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}
