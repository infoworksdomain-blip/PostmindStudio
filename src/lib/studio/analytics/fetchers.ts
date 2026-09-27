import { NotImplementedError, PlatformError } from '../../errors';
import { platformRequest } from '../platforms/http';
import { LINKEDIN_VERSION } from '../platforms/linkedin';
import type { Platform } from '../services/catalog';
import type { MetricSnapshot } from './store';

// BACKLOG 11.1 / spec 15.1 — per-platform metrics for a published post, using the Studio
// connection's user token. Shapes from the platforms' docs (read 2026-09-27):
//  TikTok   POST open.tiktokapis.com/v2/video/query/?fields=… {filters:{video_ids}} (video.list);
//           the post id comes from publish/status/fetch publicaly_available_post_id.
//  YouTube  GET youtube/v3/videos?part=statistics (strings); YouTube Analytics v2 reports
//           (yt-analytics.readonly) for watch time / average view %.
//  X        GET /2/tweets/:id?tweet.fields=public_metrics[,non_public_metrics] (own posts, 30d).
//  LinkedIn GET /rest/memberCreatorPostAnalytics (r_member_postAnalytics — Community
//           Management API, vetted access; enabled only with LINKEDIN_POST_ANALYTICS=enabled).
//  Instagram/Facebook: blocked on Engagement's Meta credentials (Phase 5 review list).

export interface FetchMetricsRequest {
  accessToken: string;
  accountId: string;
  platformPostId: string;
  publishedAt: Date;
  now: number;
}

export interface FetchMetricsResult {
  snapshot: MetricSnapshot;
  /** Set when the platform id was resolved (TikTok publish id → post id). */
  platformPostId?: string;
  /** Metrics the connection's scopes or access level could not read. */
  unavailable?: string[];
}

export interface MetricsFetcher {
  readonly platform: Platform;
  fetch(request: FetchMetricsRequest): Promise<FetchMetricsResult>;
}

interface Deps {
  fetchImpl: typeof fetch;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// ---------------------------------------------------------------- TikTok

const TIKTOK_API = 'https://open.tiktokapis.com';

/** TikTok post ids are int64 numbers; publish ids are not ("v_pub_…"). */
export function isTikTokPostId(id: string): boolean {
  return /^\d{5,}$/.test(id);
}

export function createTikTokMetrics(deps: Deps): MetricsFetcher {
  return {
    platform: 'tiktok',
    async fetch(req) {
      let postId = req.platformPostId;
      if (!isTikTokPostId(postId)) {
        const { body } = await platformRequest<{
          data?: { publicaly_available_post_id?: Array<number | string> };
        }>(
          `${TIKTOK_API}/v2/post/publish/status/fetch/`,
          {
            method: 'POST',
            headers: {
              ...auth(req.accessToken),
              'Content-Type': 'application/json; charset=UTF-8',
            },
            body: JSON.stringify({ publish_id: postId }),
          },
          { platform: 'tiktok', fetchImpl: deps.fetchImpl },
        );
        const resolved = body.data?.publicaly_available_post_id?.[0];
        // Not public yet (moderation can take hours): no metrics this round.
        if (resolved === undefined) {
          return {
            snapshot: { views: 0, likes: 0, comments: 0, shares: 0 },
            unavailable: ['not_public_yet'],
          };
        }
        postId = String(resolved);
      }
      const fields = 'id,view_count,like_count,comment_count,share_count';
      const { body } = await platformRequest<{
        data?: {
          videos?: Array<{
            id: string;
            view_count?: number;
            like_count?: number;
            comment_count?: number;
            share_count?: number;
          }>;
        };
      }>(
        `${TIKTOK_API}/v2/video/query/?fields=${fields}`,
        {
          method: 'POST',
          headers: { ...auth(req.accessToken), 'Content-Type': 'application/json' },
          body: JSON.stringify({ filters: { video_ids: [postId] } }),
        },
        { platform: 'tiktok', fetchImpl: deps.fetchImpl },
      );
      const video = body.data?.videos?.find((v) => v.id === postId);
      if (!video)
        throw new PlatformError(
          'tiktok',
          'invalid_request',
          'TikTok returned no metrics for this post',
          true,
        );
      return {
        platformPostId: postId,
        snapshot: {
          views: video.view_count ?? 0,
          likes: video.like_count ?? 0,
          comments: video.comment_count ?? 0,
          shares: video.share_count ?? 0,
        },
        // Watch time and completion are TikTok Business API only.
        unavailable: ['watch_time', 'avg_watch_pct'],
      };
    },
  };
}

// ---------------------------------------------------------------- YouTube

const YT_DATA = 'https://www.googleapis.com/youtube/v3';
const YT_ANALYTICS = 'https://youtubeanalytics.googleapis.com/v2/reports';

interface YouTubeReport {
  columnHeaders?: Array<{ name: string }>;
  rows?: Array<Array<string | number>>;
}

export function readReport(report: YouTubeReport): Record<string, number> {
  const row = report.rows?.[0];
  if (!row) return {};
  return Object.fromEntries(
    (report.columnHeaders ?? []).map((h, i) => [h.name, Number(row[i] ?? 0)]),
  );
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function createYouTubeMetrics(deps: Deps): MetricsFetcher {
  return {
    platform: 'youtube_short',
    async fetch(req) {
      const { body } = await platformRequest<{
        items?: Array<{
          statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
        }>;
      }>(
        `${YT_DATA}/videos?part=statistics&id=${encodeURIComponent(req.platformPostId)}`,
        { method: 'GET', headers: auth(req.accessToken) },
        { platform: 'youtube', fetchImpl: deps.fetchImpl },
      );
      const stats = body.items?.[0]?.statistics;
      if (!stats)
        throw new PlatformError(
          'youtube',
          'invalid_request',
          'YouTube returned no statistics',
          true,
        );
      const snapshot: MetricSnapshot = {
        views: Number(stats.viewCount ?? 0),
        likes: Number(stats.likeCount ?? 0),
        comments: Number(stats.commentCount ?? 0),
        shares: 0,
      };
      const unavailable: string[] = [];
      try {
        const params = new URLSearchParams({
          ids: 'channel==MINE',
          startDate: ymd(req.publishedAt.getTime()),
          endDate: ymd(req.now),
          metrics: 'estimatedMinutesWatched,averageViewPercentage,shares',
          filters: `video==${req.platformPostId}`,
        });
        const { body: report } = await platformRequest<YouTubeReport>(
          `${YT_ANALYTICS}?${params}`,
          { method: 'GET', headers: auth(req.accessToken) },
          { platform: 'youtube', fetchImpl: deps.fetchImpl },
        );
        const m = readReport(report);
        snapshot.watchTimeSec = Math.round((m.estimatedMinutesWatched ?? 0) * 60);
        snapshot.avgWatchTimePct =
          m.averageViewPercentage !== undefined ? m.averageViewPercentage / 100 : null;
        snapshot.shares = m.shares ?? 0;
      } catch (err) {
        // Connections made before yt-analytics.readonly was requested (or channels without
        // Analytics data yet) still get the public counters.
        if (!(err instanceof PlatformError)) throw err;
        unavailable.push('watch_time', 'avg_watch_pct', 'shares');
      }
      return { snapshot, unavailable };
    },
  };
}

// ---------------------------------------------------------------- X

const X_API = 'https://api.x.com';
const X_PRIVATE_METRICS_DAYS = 30;

export function createXMetrics(deps: Deps): MetricsFetcher {
  return {
    platform: 'x',
    async fetch(req) {
      const recent = req.now - req.publishedAt.getTime() < X_PRIVATE_METRICS_DAYS * 86_400_000;
      const fields = recent ? 'public_metrics,non_public_metrics' : 'public_metrics';
      const { body } = await platformRequest<{
        data?: {
          public_metrics?: {
            impression_count?: number;
            like_count?: number;
            reply_count?: number;
            retweet_count?: number;
            quote_count?: number;
            bookmark_count?: number;
          };
          non_public_metrics?: { url_link_clicks?: number };
        };
      }>(
        `${X_API}/2/tweets/${encodeURIComponent(req.platformPostId)}?tweet.fields=${fields}`,
        { method: 'GET', headers: auth(req.accessToken) },
        { platform: 'x', fetchImpl: deps.fetchImpl },
      );
      const p = body.data?.public_metrics;
      if (!p)
        throw new PlatformError(
          'x',
          'invalid_request',
          'X returned no metrics for this post',
          true,
        );
      return {
        snapshot: {
          views: p.impression_count ?? 0,
          likes: p.like_count ?? 0,
          comments: p.reply_count ?? 0,
          shares: (p.retweet_count ?? 0) + (p.quote_count ?? 0),
          saves: p.bookmark_count ?? 0,
          clicks: body.data?.non_public_metrics?.url_link_clicks ?? 0,
        },
        unavailable: ['watch_time', 'avg_watch_pct'],
      };
    },
  };
}

// ---------------------------------------------------------------- LinkedIn

const LI_METRICS = ['IMPRESSION', 'REACTION', 'COMMENT', 'RESHARE'] as const;

/** Rest.li entity for a post URN: urn:li:share:… → (share:…), urn:li:ugcPost:… → (ugc:…). */
export function linkedInEntity(urn: string): string {
  const key = urn.startsWith('urn:li:ugcPost:') ? 'ugc' : 'share';
  return `(${key}:${encodeURIComponent(urn)})`;
}

export function createLinkedInMetrics(deps: Deps & { enabled: boolean }): MetricsFetcher {
  return {
    platform: 'linkedin_video',
    async fetch(req) {
      if (!deps.enabled) {
        throw new NotImplementedError(
          'LinkedIn post analytics need the Community Management API (r_member_postAnalytics), a vetted LinkedIn product',
        );
      }
      const counts: Partial<Record<(typeof LI_METRICS)[number], number>> = {};
      for (const metric of LI_METRICS) {
        const { body } = await platformRequest<{ elements?: Array<{ count?: number }> }>(
          `https://api.linkedin.com/rest/memberCreatorPostAnalytics?q=entity&entity=${linkedInEntity(req.platformPostId)}&queryType=${metric}&aggregation=TOTAL`,
          {
            method: 'GET',
            headers: {
              ...auth(req.accessToken),
              'Linkedin-Version': LINKEDIN_VERSION,
              'X-Restli-Protocol-Version': '2.0.0',
            },
          },
          { platform: 'linkedin', fetchImpl: deps.fetchImpl },
        );
        counts[metric] = body.elements?.reduce((t, e) => t + (e.count ?? 0), 0) ?? 0;
      }
      return {
        snapshot: {
          views: counts.IMPRESSION ?? 0,
          likes: counts.REACTION ?? 0,
          comments: counts.COMMENT ?? 0,
          shares: counts.RESHARE ?? 0,
        },
        unavailable: ['watch_time', 'avg_watch_pct'],
      };
    },
  };
}

export type MetricsRegistry = Partial<Record<Platform, MetricsFetcher>>;

export function createMetricsRegistry(deps: Deps & { linkedInEnabled: boolean }): MetricsRegistry {
  const youtube = createYouTubeMetrics(deps);
  return {
    tiktok: createTikTokMetrics(deps),
    youtube_short: youtube,
    youtube: { ...youtube, platform: 'youtube' },
    x: createXMetrics(deps),
    linkedin_video: createLinkedInMetrics({ ...deps, enabled: deps.linkedInEnabled }),
  };
}
