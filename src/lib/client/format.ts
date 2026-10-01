import { useLocale, useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { DEFAULT_LOCALE } from '@/lib/i18n/locales';
import type { Messages } from '@/lib/i18n/messages';

// Display helpers shared by Studio screens. BACKLOG 16.1: every formatter takes the active locale
// (Intl.* does the work); money stays GBP in every locale — only the presentation changes
// (£1,234.50 in en-GB, 1 234,50 £GB in fr). The plain functions default to en-GB so existing
// callers keep working; screens use useFormat(), which binds them to the active locale and the
// `format` catalogue (duration units, "just now", state and platform labels).

export function formatPence(
  pence: number | null | undefined,
  locale: string = DEFAULT_LOCALE,
): string {
  const value = (pence ?? 0) / 100;
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'GBP' }).format(value);
}

export function formatCount(n: number | null | undefined, locale: string = DEFAULT_LOCALE): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(
    n ?? 0,
  );
}

export function formatNumber(
  n: number | null | undefined,
  locale: string = DEFAULT_LOCALE,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, options).format(n ?? 0);
}

export interface DurationParts {
  kind: 'hours' | 'minutes' | 'seconds';
  hours: number;
  minutes: number;
  seconds: number;
}

export function durationParts(totalSec: number | null | undefined): DurationParts {
  const sec = Math.max(0, Math.round(totalSec ?? 0));
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;
  const kind = hours ? 'hours' : minutes ? 'minutes' : 'seconds';
  return { kind, hours, minutes, seconds };
}

/** English duration (1h 05m, 3:07, 42s). Screens use useFormat().duration for other locales. */
export function formatDuration(totalSec: number | null | undefined): string {
  const { kind, hours: h, minutes: m, seconds: s } = durationParts(totalSec);
  if (kind === 'hours') return `${h}h ${String(m).padStart(2, '0')}m`;
  if (kind === 'minutes') return `${m}:${String(s).padStart(2, '0')}`;
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

export interface RelativeTimeOptions {
  locale?: string;
  /** Under a minute: "just now" in English; the catalogue's format.justNow via useFormat. */
  justNow?: string;
  /** The placeholder for a missing date. */
  none?: string;
}

export function relativeTime(
  iso: string | null | undefined,
  now: number = Date.now(),
  options: RelativeTimeOptions = {},
): string {
  if (!iso) return options.none ?? '—';
  const diff = new Date(iso).getTime() - now;
  const rtf = new Intl.RelativeTimeFormat(options.locale ?? DEFAULT_LOCALE, { numeric: 'auto' });
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return options.justNow ?? 'just now';
}

export function formatDate(
  iso: string | null | undefined,
  locale: string = DEFAULT_LOCALE,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(locale, options).format(new Date(iso));
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
  ARCHIVED: { label: 'Archived', tone: 'neutral' },
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

type FormatMessages = Messages['format'];
type ProjectStateKey = keyof FormatMessages['projectState'];
type PublicationStateKey = keyof FormatMessages['publicationState'];
type PlatformKey = keyof FormatMessages['platform'];

function hasKey<T extends object>(map: T, key: string): key is Extract<keyof T, string> {
  return Object.prototype.hasOwnProperty.call(map, key);
}

export interface StudioFormat {
  locale: string;
  /** Pence → GBP in the locale's currency presentation. */
  pence: (pence: number | null | undefined) => string;
  /** Compact counts (1.2K, 1,2 k, 1.2万). */
  count: (n: number | null | undefined) => string;
  number: (n: number | null | undefined, options?: Intl.NumberFormatOptions) => string;
  percent: (fraction: number | null | undefined, maximumFractionDigits?: number) => string;
  duration: (totalSec: number | null | undefined) => string;
  relative: (iso: string | null | undefined, now?: number) => string;
  /** Date and time (medium date, short time) unless options say otherwise. */
  date: (iso: string | null | undefined, options?: Intl.DateTimeFormatOptions) => string;
  /** "a, b and c" in the locale's list style. */
  list: (items: readonly string[], type?: Intl.ListFormatType) => string;
  projectState: (state: string) => { label: string; tone: Tone };
  publicationState: (state: string) => { label: string; tone: Tone };
  platform: (platform: string) => string;
}

/**
 * Locale-bound formatters for Client Components (BACKLOG 16.1). Use this instead of the plain
 * functions in any localised screen:
 *
 *   const f = useFormat();
 *   f.pence(project.costPence); f.relative(p.createdAt); f.projectState(p.state).label
 */
export function useFormat(): StudioFormat {
  const locale = useLocale();
  const t = useTranslations('format');
  return useMemo<StudioFormat>(() => {
    const none = t('none');
    const twoDigits = new Intl.NumberFormat(locale, { minimumIntegerDigits: 2 });
    const plain = new Intl.NumberFormat(locale);
    return {
      locale,
      pence: (p) => formatPence(p, locale),
      count: (n) => formatCount(n, locale),
      number: (n, options) => formatNumber(n, locale, options),
      percent: (fraction, maximumFractionDigits = 0) =>
        formatNumber(fraction, locale, { style: 'percent', maximumFractionDigits }),
      duration: (totalSec) => {
        const d = durationParts(totalSec);
        if (d.kind === 'hours')
          return t('duration.hoursMinutes', {
            hours: plain.format(d.hours),
            minutes: twoDigits.format(d.minutes),
          });
        if (d.kind === 'minutes')
          return t('duration.minutesSeconds', {
            minutes: plain.format(d.minutes),
            seconds: twoDigits.format(d.seconds),
          });
        return t('duration.seconds', { seconds: plain.format(d.seconds) });
      },
      relative: (iso, now) => relativeTime(iso, now, { locale, justNow: t('justNow'), none }),
      date: (iso, options) => (iso ? formatDate(iso, locale, options) : none),
      list: (items, type = 'conjunction') =>
        new Intl.ListFormat(locale, { style: 'long', type }).format(items),
      projectState: (state) => {
        const known = stateOf(PROJECT_STATE, state);
        return hasKey(PROJECT_STATE, state)
          ? { label: t(`projectState.${state as ProjectStateKey}`), tone: known.tone }
          : known;
      },
      publicationState: (state) => {
        const known = stateOf(PUBLICATION_STATE, state);
        return hasKey(PUBLICATION_STATE, state)
          ? { label: t(`publicationState.${state as PublicationStateKey}`), tone: known.tone }
          : known;
      },
      platform: (platform) =>
        hasKey(PLATFORM_LABEL, platform) ? t(`platform.${platform as PlatformKey}`) : platform,
    };
  }, [locale, t]);
}
