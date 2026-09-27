// Engagement model behind the analytics endpoints (agent "insight"). Every publication in the
// shared publications store that went live gets cumulative counts that grow from publishedAt
// with a platform-shaped decay curve, so a post published during the demo starts earning views
// too. The Saturday sourdough class launch posts get the viral boost behind the spike.
import type { Publication } from '@/lib/client/types';
import { PUBLICATIONS } from '../ids';
import { listPublications } from './publications-store';

const HOUR = 3_600_000;

export interface Counts {
  views: number;
  watchTimeSec: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
}

interface PlatformShape {
  peakViews: number;
  tauHours: number;
  watchSec: number;
  likeRate: number;
}

const SHAPE: Record<string, PlatformShape> = {
  tiktok: { peakViews: 7_800, tauHours: 30, watchSec: 9, likeRate: 0.071 },
  instagram_reel: { peakViews: 4_600, tauHours: 42, watchSec: 8, likeRate: 0.064 },
  youtube_short: { peakViews: 3_900, tauHours: 70, watchSec: 13, likeRate: 0.041 },
  youtube: { peakViews: 1_400, tauHours: 160, watchSec: 52, likeRate: 0.035 },
  facebook: { peakViews: 1_700, tauHours: 36, watchSec: 7, likeRate: 0.029 },
  linkedin_video: { peakViews: 1_150, tauHours: 48, watchSec: 15, likeRate: 0.022 },
  x: { peakViews: 900, tauHours: 14, watchSec: 5, likeRate: 0.018 },
};
const DEFAULT_SHAPE: PlatformShape = {
  peakViews: 1_000,
  tauHours: 40,
  watchSec: 8,
  likeRate: 0.03,
};

/** The class launch trio went properly viral in Leeds. */
const LAUNCH_BOOST: Record<string, number> = {
  [PUBLICATIONS.classTiktok]: 6.2,
  [PUBLICATIONS.classReels]: 4.1,
  [PUBLICATIONS.classShorts]: 3.4,
};
/** Taken-down posts stop collecting snapshots this long after publishing. */
const TAKEDOWN_AFTER_H = 21 * 24;

function hashUnit(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return (h % 10_000) / 10_000;
}

export interface LivePost {
  pub: Publication;
  publishedMs: number;
}

export function livePosts(): LivePost[] {
  return listPublications()
    .filter((p) => (p.state === 'PUBLISHED' || p.state === 'TAKEN_DOWN') && p.publishedAt)
    .map((pub) => ({ pub, publishedMs: Date.parse(pub.publishedAt ?? '') }))
    .filter((p) => Number.isFinite(p.publishedMs));
}

/** Cumulative counts for a post at time `at` (ms). */
export function countsAt(post: LivePost, at: number): Counts {
  const { pub, publishedMs } = post;
  const shape = SHAPE[pub.platform] ?? DEFAULT_SHAPE;
  let hours = Math.max(0, (at - publishedMs) / HOUR);
  if (pub.state === 'TAKEN_DOWN') hours = Math.min(hours, TAKEDOWN_AFTER_H);
  const u = hashUnit(pub.id);
  const peak = shape.peakViews * (0.55 + u) * (LAUNCH_BOOST[pub.id] ?? 1);
  // Fast early curve plus a slow long tail (search / suggested traffic).
  const views =
    peak * (0.85 * (1 - Math.exp(-hours / shape.tauHours)) + 0.15 * (1 - Math.exp(-hours / 900)));
  const boosted = LAUNCH_BOOST[pub.id] ? 1.35 : 1;
  const likes = views * shape.likeRate * (0.8 + u * 0.4) * boosted;
  return {
    views: Math.round(views),
    watchTimeSec: Math.round(views * shape.watchSec * (0.85 + u * 0.3)),
    likes: Math.round(likes),
    comments: Math.round(likes * 0.09 * boosted),
    shares: Math.round(likes * 0.14 * boosted),
    saves: Math.round(likes * (LAUNCH_BOOST[pub.id] ? 0.42 : 0.17)),
  };
}

export type Metric = 'views' | 'watchTime' | 'engagement' | 'likes' | 'comments' | 'shares';
export const METRICS: Metric[] = [
  'views',
  'watchTime',
  'engagement',
  'likes',
  'comments',
  'shares',
];

export function metricValue(c: Counts, metric: Metric): number {
  switch (metric) {
    case 'views':
      return c.views;
    case 'watchTime':
      return c.watchTimeSec;
    case 'engagement':
      return c.likes + c.comments + c.shares + c.saves;
    case 'likes':
      return c.likes;
    case 'comments':
      return c.comments;
    case 'shares':
      return c.shares;
  }
}
