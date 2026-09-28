// Display helpers shared by Studio screens (en-GB, GBP).

export function formatPence(pence: number | null | undefined): string {
  const value = (pence ?? 0) / 100;
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(value);
}

export function formatCount(n: number | null | undefined): string {
  return new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 }).format(
    n ?? 0,
  );
}

export function formatDuration(totalSec: number | null | undefined): string {
  const sec = Math.max(0, Math.round(totalSec ?? 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}:${String(s).padStart(2, '0')}`;
  return `${s}s`;
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['week', 7 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - now;
  const rtf = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return 'just now';
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
}

/**
 * Only `http(s)://` URLs are safe to render as an `href`/`src` from API data (platform
 * permalinks, signed asset URLs). Rejects `javascript:`, `data:` and other schemes that would
 * execute in the browser if a link like this is ever clicked.
 */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export type Tone = 'neutral' | 'live' | 'good' | 'warn' | 'bad';

/** Project states (spec 7.x) → label + tone. "live" = work in progress (the record light). */
export const PROJECT_STATE: Record<string, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  QUEUED: { label: 'Queued', tone: 'live' },
  SCANNING: { label: 'Auto-populating', tone: 'live' },
  PLANNING: { label: 'Writing script', tone: 'live' },
  ASSETS_QUEUED: { label: 'Generating shots', tone: 'live' },
  ASSETS_GENERATING: { label: 'Generating shots', tone: 'live' },
  RENDERING: { label: 'Rendering', tone: 'live' },
  QUALITY_CHECKING: { label: 'Checking quality', tone: 'live' },
  QUALITY_FAILED: { label: 'Quality check failed', tone: 'warn' },
  READY_FOR_REVIEW: { label: 'Ready for review', tone: 'good' },
  APPROVED: { label: 'Approved', tone: 'good' },
  PUBLISHING: { label: 'Publishing', tone: 'live' },
  PUBLISHED: { label: 'Published', tone: 'good' },
  PARTIALLY_PUBLISHED: { label: 'Partly published', tone: 'warn' },
  REJECTED: { label: 'Rejected', tone: 'bad' },
  FAILED: { label: 'Failed', tone: 'bad' },
};

export const PUBLICATION_STATE: Record<string, { label: string; tone: Tone }> = {
  SCHEDULED: { label: 'Scheduled', tone: 'neutral' },
  PUBLISHING: { label: 'Publishing', tone: 'live' },
  PUBLISHED: { label: 'Live', tone: 'good' },
  FAILED: { label: 'Failed', tone: 'bad' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  TAKEN_DOWN: { label: 'Taken down', tone: 'warn' },
};

export const PLATFORM_LABEL: Record<string, string> = {
  tiktok: 'TikTok',
  instagram_reel: 'Instagram Reels',
  youtube_short: 'YouTube Shorts',
  youtube: 'YouTube',
  linkedin_video: 'LinkedIn',
  x: 'X',
  facebook: 'Facebook Reels',
  instagram_feed: 'Instagram feed',
  facebook_feed: 'Facebook feed',
};

export function stateOf(map: Record<string, { label: string; tone: Tone }>, state: string) {
  return map[state] ?? { label: state.replace(/_/g, ' ').toLowerCase(), tone: 'neutral' as Tone };
}

/** Active pipeline states: the review screen polls while a project is in one of these. */
export const ACTIVE_STATES = new Set(
  Object.entries(PROJECT_STATE)
    .filter(([, v]) => v.tone === 'live')
    .map(([k]) => k),
);
