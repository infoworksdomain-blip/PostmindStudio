// Response shapes of /api/studio/analytics/* (src/lib/studio/services/analytics.ts).
// Kept by hand — the UI never imports server modules.

export const RANGE_DAYS = [7, 30, 90] as const;
export type RangeDays = (typeof RANGE_DAYS)[number];

export const METRICS = ['views', 'watchTime', 'engagement', 'likes', 'comments', 'shares'] as const;
export type Metric = (typeof METRICS)[number];

export interface OverviewResponse {
  ok: true;
  days: number;
  /** 25.11: the business the totals are narrowed to; null (or absent) = all businesses. */
  businessId?: string | null;
  publications: number;
  projectsCreated: number;
  totals: {
    views: number;
    watchTimeSec: number;
    likes: number;
    comments: number;
    shares: number;
    saves: number;
  };
  byPlatform: Record<string, { publications: number; views: number; engagement: number }>;
}

export interface TimeseriesResponse {
  ok: true;
  metric: Metric;
  data: Array<{ day: string; value: number; estimated?: true }>;
}

export interface LeaderboardEntry {
  id: string;
  /** 25.11: the published render (its thumbnail comes from GET /renders/:id). */
  renderId?: string;
  platform: string;
  platformUrl: string | null;
  publishedAt: string | null;
  projectId: string;
  caption: string | null;
  value: number;
}

export interface LeaderboardResponse {
  ok: true;
  metric: Metric;
  data: LeaderboardEntry[];
}

export interface CostResponse {
  ok: true;
  days: number;
  totalPence: number;
  byProvider: Array<{ provider: string; costPence: number; jobs: number }>;
  byProject: Array<{ projectId: string | null; name: string | null; costPence: number }>;
  byDay: Array<{ day: string; costPence: number }>;
}

export interface SeriesPoint {
  label: string;
  value: number;
}

/** GET /analytics/publications/:id (BACKLOG 11.3 + 13.28 retention/demographics). */
export interface PublicationPoint {
  at: string;
  views: number;
  watchTimeSec: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
}

export interface PublicationAnalyticsResponse {
  ok: true;
  publication: {
    id: string;
    /** 25.11: present on current servers; the drill-down shows the render's thumbnail. */
    projectId?: string;
    renderId?: string;
    caption?: string | null;
    platform: string;
    platformUrl: string | null;
    publishedAt: string | null;
    state: string;
  };
  latest:
    | (PublicationPoint & {
        uniqueViewers: number | null;
        avgWatchTimePct: number | null;
        clicks: number;
      })
    | null;
  hourly: PublicationPoint[];
  daily: PublicationPoint[];
  /** audienceWatchRatio by share of the video elapsed (YouTube). */
  retention: Array<{ atPct: number; watchingPct: number }>;
  /** viewerPercentage by age group and gender (YouTube). */
  demographics: Array<{ ageGroup: string; gender: string; pct: number }>;
}

/** GET /analytics/best-times (15.A6) — advisory; weekday 0 = Sunday, hour in `timezone`. */
export interface BestSlot {
  weekday: number;
  hour: number;
  /** Mean views relative to the best slot, 0–1. */
  score: number;
  basis: string;
}

export interface BestTimesResponse {
  ok: true;
  data: BestSlot[];
  bestPerDay: BestSlot[];
  sufficientData: boolean;
  videos: number;
  minVideos: number;
  timezone: string;
  styleMemory: { peakHourUtc: number; hour: number | null; summary: string } | null;
}
