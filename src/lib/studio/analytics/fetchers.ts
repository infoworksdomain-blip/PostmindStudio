import { NotImplementedError, PlatformError } from '../../errors';
import { platformRequest } from '../platforms/http';
import { LINKEDIN_VERSION } from '../platforms/linkedin';
import { DEFAULT_GRAPH_VERSION, GRAPH_HOST, graphProof } from '../platforms/meta';
import type { Platform } from '../services/catalog';
import type { DemographicSlice, MetricSnapshot, RetentionPoint } from './store';

// BACKLOG 11.1 / spec 15.1 — per-platform metrics for a published post, using the Studio
// connection's user token. Shapes from the platforms' docs (read 2026-09-27):
//  TikTok   POST open.tiktokapis.com/v2/video/query/?fields=… {filters:{video_ids}} (video.list);
//           the post id comes from publish/status/fetch publicaly_available_post_id.
//  YouTube  GET youtube/v3/videos?part=statistics (strings); YouTube Analytics v2 reports
//           (yt-analytics.readonly) for watch time / average view %.
//  X        GET /2/tweets/:id?tweet.fields=public_metrics[,non_public_metrics] (own posts, 30d).
//  LinkedIn GET /rest/memberCreatorPostAnalytics (r_member_postAnalytics — Community
//           Management API, vetted access; enabled only with LINKEDIN_POST_ANALYTICS=enabled).
//  Instagram GET graph.facebook.com/{v}/{ig-media-id}/insights · Facebook GET /{video-id}/video_insights
//           (sections below cite the reference pages; tokens are the Core-registered channels').

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

// 13.28 — YouTube Analytics API v2 reports.query (developers.google.com/youtube/analytics/
// channel_reports, read 2026-09-27):
//  "Audience retention": dimensions=elapsedVideoTimeRatio (required), metrics=audienceWatchRatio,
//    filters=video==<one id> (required; "the value must specify a single video ID").
//  "Viewer demographics": dimensions=ageGroup,gender, metrics=viewerPercentage, filters
//    video==<id>. ageGroup values are age13-17 … age65- (dimensions reference).
// Analytics data lags by about a day, so these are read only once a video is a day old.
export const YT_DEEP_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_RETENTION_POINTS = 100;

/** 'age18-24' → '18-24', 'age65-' → '65+'. */
export function ageGroupLabel(value: string): string {
  const m = /^age(\d+)-(\d*)$/.exec(value);
  if (!m) return value;
  return m[2] ? `${m[1]}-${m[2]}` : `${m[1]}+`;
}

export function readRetention(report: YouTubeReport): RetentionPoint[] {
  const names = (report.columnHeaders ?? []).map((h) => h.name);
  const at = names.indexOf('elapsedVideoTimeRatio');
  const ratio = names.indexOf('audienceWatchRatio');
  if (at === -1 || ratio === -1) return [];
  return (report.rows ?? [])
    .map((row) => ({ atPct: Number(row[at]), watchingPct: Number(row[ratio]) }))
    .filter((p) => Number.isFinite(p.atPct) && Number.isFinite(p.watchingPct))
    .sort((a, b) => a.atPct - b.atPct)
    .slice(0, MAX_RETENTION_POINTS);
}

export function readDemographics(report: YouTubeReport): DemographicSlice[] {
  const names = (report.columnHeaders ?? []).map((h) => h.name);
  const age = names.indexOf('ageGroup');
  const gender = names.indexOf('gender');
  const pct = names.indexOf('viewerPercentage');
  if (age === -1 || gender === -1 || pct === -1) return [];
  return (report.rows ?? [])
    .map((row) => ({
      ageGroup: ageGroupLabel(String(row[age])),
      gender: String(row[gender]),
      pct: Number(row[pct]),
    }))
    .filter((s) => Number.isFinite(s.pct) && s.pct > 0)
    .sort((a, b) => b.pct - a.pct);
}

async function youTubeDeepAnalytics(
  deps: Deps,
  req: FetchMetricsRequest,
): Promise<{
  retentionCurve?: RetentionPoint[];
  demographics?: DemographicSlice[];
  unavailable: string[];
}> {
  const unavailable: string[] = [];
  const report = async (dimensions: string, metrics: string) => {
    const params = new URLSearchParams({
      ids: 'channel==MINE',
      startDate: ymd(req.publishedAt.getTime()),
      endDate: ymd(req.now),
      dimensions,
      metrics,
      filters: `video==${req.platformPostId}`,
    });
    const { body } = await platformRequest<YouTubeReport>(
      `${YT_ANALYTICS}?${params}`,
      { method: 'GET', headers: auth(req.accessToken) },
      { platform: 'youtube', fetchImpl: deps.fetchImpl },
    );
    return body;
  };
  let retentionCurve: RetentionPoint[] | undefined;
  let demographics: DemographicSlice[] | undefined;
  try {
    const points = readRetention(await report('elapsedVideoTimeRatio', 'audienceWatchRatio'));
    if (points.length) retentionCurve = points;
  } catch (err) {
    if (!(err instanceof PlatformError)) throw err;
    unavailable.push('retention');
  }
  try {
    const slices = readDemographics(await report('ageGroup,gender', 'viewerPercentage'));
    if (slices.length) demographics = slices;
  } catch (err) {
    if (!(err instanceof PlatformError)) throw err;
    unavailable.push('demographics');
  }
  return { retentionCurve, demographics, unavailable };
}

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
      // 13.28: retention curve and audience, once the video is old enough to have them.
      if (req.now - req.publishedAt.getTime() >= YT_DEEP_MIN_AGE_MS) {
        const deep = await youTubeDeepAnalytics(deps, req);
        if (deep.retentionCurve) snapshot.retentionCurve = deep.retentionCurve;
        if (deep.demographics) snapshot.demographics = deep.demographics;
        unavailable.push(...deep.unavailable);
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

// ---------------------------------------------------------------- Meta (Instagram / Facebook)

/** One InsightsResult node (Graph API): lifetime metrics carry values[0].value. */
interface InsightsNode {
  name?: string;
  period?: string;
  values?: Array<{ value?: unknown }>;
  total_value?: { value?: unknown };
}

/** name → value for the metrics Meta returned (a metric absent from `data` is left out). */
export function readInsights(data: InsightsNode[] | undefined): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const node of data ?? []) {
    if (!node.name) continue;
    const value = node.values?.[0]?.value ?? node.total_value?.value;
    if (value !== undefined && value !== null) out.set(node.name, value);
  }
  return out;
}

const asCount = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** A number, or the sum of a { type: count } object (by-reaction-type style metrics). */
export function countOrSum(v: unknown): number | undefined {
  const n = asCount(v);
  if (n !== undefined) return n;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const parts = Object.values(v as Record<string, unknown>).map(asCount);
    if (parts.length > 0 && parts.every((p) => p !== undefined))
      return parts.reduce<number>((t, p) => t + (p ?? 0), 0);
  }
  return undefined;
}

interface MetaDeps extends Deps {
  graphVersion?: string;
  /** Phase 18: Studio's Meta app secret (standalone) → appsecret_proof on insights calls. */
  metaAppSecret?: string;
}

function metaInsights(
  deps: MetaDeps,
  platform: 'instagram' | 'facebook',
  path: string,
  metrics: readonly string[],
  token: string,
) {
  const params = new URLSearchParams({ metric: metrics.join(','), access_token: token });
  if (deps.metaAppSecret) params.set('appsecret_proof', graphProof(token, deps.metaAppSecret));
  return platformRequest<{ data?: InsightsNode[] }>(
    `${GRAPH_HOST}/${deps.graphVersion ?? DEFAULT_GRAPH_VERSION}${path}?${params}`,
    { method: 'GET' },
    {
      platform,
      fetchImpl: deps.fetchImpl,
      describe: (body) => {
        const e = (body as { error?: { message?: string; code?: number } } | undefined)?.error;
        return { message: e?.message, code: e?.code ? String(e.code) : undefined };
      },
      // Graph error 190 = invalid/expired token (reconnect); 4/17/32/613 = rate limits.
      // https://developers.facebook.com/docs/graph-api/guides/error-handling
      refine: (_status, code) => {
        if (code === '190') return { errorClass: 'needs_reconnect', retryable: false };
        if (code === '4' || code === '17' || code === '32' || code === '613')
          return { errorClass: 'rate_limited', retryable: true };
        return undefined;
      },
    },
  );
}

/**
 * Instagram Reels: GET /{ig-media-id}/insights (read 2026-09-27)
 * https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights
 * REELS support views, reach, likes, comments, shares, saved, total_interactions,
 * ig_reels_avg_watch_time and ig_reels_video_view_total_time. Needs instagram_manage_insights
 * (Facebook Login) or instagram_business_manage_insights (Instagram Login). "If insights data you
 * are requesting does not exist or is currently unavailable, the API returns an empty data set
 * instead of 0"; data "can be delayed up to 48 hours". A missing metric is listed in
 * `unavailable` for that poll (recorded as 0 like TikTok's not-public-yet case; later polls
 * overwrite the cumulative snapshot).
 * Watch time is NOT read: the reference does not state the unit of the ig_reels_* time metrics,
 * and Studio does not guess (CLAUDE.md rule 2), so it is reported unavailable.
 */
export const INSTAGRAM_REEL_METRICS = [
  'views',
  'reach',
  'likes',
  'comments',
  'shares',
  'saved',
] as const;

export function createInstagramMetrics(deps: MetaDeps): MetricsFetcher {
  return {
    platform: 'instagram_reel',
    async fetch(req) {
      const { body } = await metaInsights(
        deps,
        'instagram',
        `/${encodeURIComponent(req.platformPostId)}/insights`,
        INSTAGRAM_REEL_METRICS,
        req.accessToken,
      );
      const m = readInsights(body.data);
      const unavailable = ['watch_time', 'avg_watch_pct'];
      for (const name of INSTAGRAM_REEL_METRICS) if (!m.has(name)) unavailable.push(name);
      return {
        snapshot: {
          views: asCount(m.get('views')) ?? 0,
          uniqueViewers: asCount(m.get('reach')) ?? null,
          likes: asCount(m.get('likes')) ?? 0,
          comments: asCount(m.get('comments')) ?? 0,
          shares: asCount(m.get('shares')) ?? 0,
          saves: asCount(m.get('saved')) ?? 0,
        },
        unavailable,
      };
    },
  };
}

/**
 * Facebook Reels: GET /{video-id}/video_insights (read 2026-09-27)
 * https://developers.facebook.com/docs/graph-api/reference/video/video_insights/
 * Reels metrics (lifetime): fb_reels_total_plays (times the reel starts to play, replays
 * included), post_impressions_unique (people who saw the reel at least once),
 * post_video_view_time ("total number of milliseconds your reel played"),
 * post_video_likes_by_reaction_type (likes on the reel). post_video_social_actions is comments
 * and shares as ONE combined figure, so neither can be split from it: both are unavailable.
 * Needs read_insights and a Page access token of someone who can perform ANALYZE on the Page.
 * The reference shows no sample values, so a by-type object is summed and anything non-numeric
 * is reported unavailable.
 */
export const FACEBOOK_REEL_METRICS = [
  'fb_reels_total_plays',
  'post_impressions_unique',
  'post_video_view_time',
  'post_video_likes_by_reaction_type',
] as const;

export function createFacebookMetrics(deps: MetaDeps): MetricsFetcher {
  return {
    platform: 'facebook',
    async fetch(req) {
      const { body } = await metaInsights(
        deps,
        'facebook',
        `/${encodeURIComponent(req.platformPostId)}/video_insights`,
        FACEBOOK_REEL_METRICS,
        req.accessToken,
      );
      const m = readInsights(body.data);
      const views = asCount(m.get('fb_reels_total_plays'));
      const reach = asCount(m.get('post_impressions_unique'));
      const viewTimeMs = asCount(m.get('post_video_view_time'));
      const likes = countOrSum(m.get('post_video_likes_by_reaction_type'));
      const unavailable = ['avg_watch_pct', 'comments', 'shares'];
      if (views === undefined) unavailable.push('views');
      if (reach === undefined) unavailable.push('unique_viewers');
      if (viewTimeMs === undefined) unavailable.push('watch_time');
      if (likes === undefined) unavailable.push('likes');
      return {
        snapshot: {
          views: views ?? 0,
          uniqueViewers: reach ?? null,
          ...(viewTimeMs !== undefined && { watchTimeSec: Math.round(viewTimeMs / 1000) }),
          likes: likes ?? 0,
          comments: 0,
          shares: 0,
        },
        unavailable,
      };
    },
  };
}

/**
 * 15.A1 — Facebook feed (non-Reels) Page videos: GET /{video-id}/video_insights (read 2026-09-28,
 * https://developers.facebook.com/docs/graph-api/reference/video/video_insights/), lifetime:
 * total_video_views ("played for at least 3 seconds"), total_video_impressions_unique,
 * total_video_view_total_time (milliseconds), total_video_reactions_by_type_total (by type,
 * summed as likes). Comments and shares only exist inside total_video_stories_by_action_type,
 * whose keys the reference does not list, so both are reported unavailable.
 */
export const FACEBOOK_FEED_METRICS = [
  'total_video_views',
  'total_video_impressions_unique',
  'total_video_view_total_time',
  'total_video_reactions_by_type_total',
] as const;

export function createFacebookFeedMetrics(deps: MetaDeps): MetricsFetcher {
  return {
    platform: 'facebook_feed',
    async fetch(req) {
      const { body } = await metaInsights(
        deps,
        'facebook',
        `/${encodeURIComponent(req.platformPostId)}/video_insights`,
        FACEBOOK_FEED_METRICS,
        req.accessToken,
      );
      const m = readInsights(body.data);
      const views = asCount(m.get('total_video_views'));
      const reach = asCount(m.get('total_video_impressions_unique'));
      const viewTimeMs = asCount(m.get('total_video_view_total_time'));
      const likes = countOrSum(m.get('total_video_reactions_by_type_total'));
      const unavailable = ['avg_watch_pct', 'comments', 'shares'];
      if (views === undefined) unavailable.push('views');
      if (reach === undefined) unavailable.push('unique_viewers');
      if (viewTimeMs === undefined) unavailable.push('watch_time');
      if (likes === undefined) unavailable.push('likes');
      return {
        snapshot: {
          views: views ?? 0,
          uniqueViewers: reach ?? null,
          ...(viewTimeMs !== undefined && { watchTimeSec: Math.round(viewTimeMs / 1000) }),
          likes: likes ?? 0,
          comments: 0,
          shares: 0,
        },
        unavailable,
      };
    },
  };
}

export type MetricsRegistry = Partial<Record<Platform, MetricsFetcher>>;

export function createMetricsRegistry(
  deps: MetaDeps & { linkedInEnabled: boolean },
): MetricsRegistry {
  const youtube = createYouTubeMetrics(deps);
  return {
    tiktok: createTikTokMetrics(deps),
    youtube_short: youtube,
    youtube: { ...youtube, platform: 'youtube' },
    x: createXMetrics(deps),
    linkedin_video: createLinkedInMetrics({ ...deps, enabled: deps.linkedInEnabled }),
    instagram_reel: createInstagramMetrics(deps),
    facebook: createFacebookMetrics(deps),
    // 15.A1: an Instagram feed video is a REELS container (share_to_feed), so Reel insights apply.
    instagram_feed: { ...createInstagramMetrics(deps), platform: 'instagram_feed' },
    facebook_feed: createFacebookFeedMetrics(deps),
  };
}
