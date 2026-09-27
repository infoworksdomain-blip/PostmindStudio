'use client';

import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { formatCount, formatDate, PLATFORM_LABEL, safeHttpUrl } from '@/lib/client/format';
import { ErrorState, Section } from '../primitives';
import { BarList } from './bar-list';
import type { LeaderboardResponse, OverviewResponse } from './types';

// Per-platform breakdown (from the overview) and the leaderboard of top publications
// (spec 14.3 "leaderboard of best-performing videos").

export function PlatformBreakdown({ overview }: { overview?: OverviewResponse }) {
  const rows = Object.entries(overview?.byPlatform ?? {})
    .map(([platform, v]) => ({
      key: platform,
      label: PLATFORM_LABEL[platform] ?? platform,
      value: v.views,
      display: formatCount(v.views),
      hint: `${v.publications} post${v.publications === 1 ? '' : 's'} · ${formatCount(v.engagement)} eng.`,
    }))
    .sort((a, b) => b.value - a.value);
  return (
    <Section title="By platform" description="Views per platform">
      {overview ? (
        <BarList rows={rows} label="Views by platform" empty="Nothing published in this window." />
      ) : (
        <Skeleton className="h-32 rounded-lg" />
      )}
    </Section>
  );
}

export function Leaderboard({ days }: { days: number }) {
  const { data, error, isLoading, mutate } = useApi<LeaderboardResponse>('/analytics/leaderboard', {
    days,
    metric: 'views',
    limit: 10,
  });
  return (
    <Section title="Top videos" description="Publications ranked by views">
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {isLoading && <Skeleton className="h-48 rounded-lg" />}
      {data && data.data.length === 0 && (
        <p className="py-6 text-sm text-muted-foreground">Nothing published in this window.</p>
      )}
      {data && data.data.length > 0 && (
        <ol aria-label="Top publications" className="divide-y divide-border/70">
          {data.data.map((p, i) => {
            const platformUrl = safeHttpUrl(p.platformUrl);
            return (
              <li key={p.id} className="grid grid-cols-[1.5rem_1fr_auto] items-center gap-3 py-2.5">
                <span className="tabular font-display text-xl text-muted-foreground">{i + 1}</span>
                <span className="min-w-0">
                  <Link
                    href={`/projects/${p.projectId}`}
                    className="block truncate text-sm font-medium hover:underline"
                  >
                    {p.caption?.trim() || 'Untitled post'}
                  </Link>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {PLATFORM_LABEL[p.platform] ?? p.platform} · {formatDate(p.publishedAt)}
                    {platformUrl && (
                      <a
                        href={platformUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open on ${PLATFORM_LABEL[p.platform] ?? p.platform}`}
                        className="hover:text-foreground"
                      >
                        <ExternalLink className="size-3" />
                      </a>
                    )}
                  </span>
                </span>
                <span className="tabular text-sm font-medium">{formatCount(p.value)}</span>
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}
