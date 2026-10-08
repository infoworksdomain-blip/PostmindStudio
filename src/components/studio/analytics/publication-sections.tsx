'use client';

import { useTranslations } from 'next-intl';
import { useFormat, type StudioFormat } from '@/lib/client/format';
import { Section } from '../primitives';
import { AreaChart } from './area-chart';
import { BarList } from './bar-list';
import type { PublicationAnalyticsResponse } from './types';

// BACKLOG 13.28 / 25.11 — the drill-down's audience sections: the retention curve and the audience
// by age and gender, where the platform reports them (YouTube), each saying why when it does not.

const YOUTUBE = new Set(['youtube', 'youtube_short']);

/** A 0–100 share as a whole percentage in the active locale (63 → '63%', '٦٣٪', '63 %'). */
export const pctText = (f: StudioFormat, v: number) => f.percent(v / 100);

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

export function RetentionSection({ data }: { data: PublicationAnalyticsResponse }) {
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

export function AudienceSection({ data }: { data: PublicationAnalyticsResponse }) {
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
