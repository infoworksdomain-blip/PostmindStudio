import type { PlatformConnection } from '@/lib/client/types';
import { belongsToBusiness } from '../connections/platforms';

// Create screen defaults (spec 14.1): platforms map to a format the platform accepts
// (platforms/rules.ts), and "Short / Long" maps to seconds per platform.

export type Length = 'short' | 'long';
export type AspectRatio = '9:16' | '16:9' | '1:1' | '4:5';

export interface PlatformOption {
  platform: string;
  aspectRatio: AspectRatio;
  shortSec: number;
  longSec: number;
}

export const PLATFORM_OPTIONS: PlatformOption[] = [
  { platform: 'tiktok', aspectRatio: '9:16', shortSec: 30, longSec: 90 },
  { platform: 'instagram_reel', aspectRatio: '9:16', shortSec: 30, longSec: 90 },
  // 15.C8: spec 5.3 "45-60s for YouTube Shorts".
  { platform: 'youtube_short', aspectRatio: '9:16', shortSec: 45, longSec: 60 },
  { platform: 'youtube', aspectRatio: '16:9', shortSec: 60, longSec: 300 },
  { platform: 'linkedin_video', aspectRatio: '16:9', shortSec: 30, longSec: 120 },
  { platform: 'x', aspectRatio: '16:9', shortSec: 30, longSec: 120 },
  { platform: 'facebook', aspectRatio: '9:16', shortSec: 30, longSec: 90 },
  // 15.A1 feed destinations (not pre-selected: CONNECTION_PLATFORMS still picks the Reels).
  { platform: 'instagram_feed', aspectRatio: '4:5', shortSec: 30, longSec: 90 },
  { platform: 'facebook_feed', aspectRatio: '1:1', shortSec: 30, longSec: 120 },
];

/** API body shape of one target format (catalog.targetFormatInput). */
export interface TargetFormatInput {
  platform: string;
  aspectRatio: AspectRatio;
  durationSec: number;
}

export function buildFormats(platforms: string[], length: Length): TargetFormatInput[] {
  return PLATFORM_OPTIONS.filter((o) => platforms.includes(o.platform)).map((o) => ({
    platform: o.platform,
    aspectRatio: o.aspectRatio,
    durationSec: length === 'short' ? o.shortSec : o.longSec,
  }));
}

/** Studio connection platform → the render platforms it publishes. */
export const CONNECTION_PLATFORMS: Record<string, string[]> = {
  tiktok: ['tiktok'],
  youtube: ['youtube_short'],
  linkedin: ['linkedin_video'],
  x: ['x'],
  instagram: ['instagram_reel'],
  facebook: ['facebook'],
};

/** Pre-select platforms the business has connected; TikTok when nothing is connected yet. */
export function defaultPlatforms(
  connections: PlatformConnection[] | undefined,
  businessId: string | null,
): string[] {
  const connected = (connections ?? [])
    .filter((c) => c.state === 'active' && belongsToBusiness(c, businessId))
    .flatMap((c) => CONNECTION_PLATFORMS[c.platform] ?? []);
  const unique = [...new Set(connected)];
  return unique.length ? unique : ['tiktok'];
}

/**
 * A project name from the brief: its first line, trimmed to a sensible length. 17.9: '' when the
 * brief is blank — the project is then created without a name (never an English placeholder).
 */
export function nameFromBrief(brief: string): string {
  const firstLine = brief.trim().split(/\r?\n/)[0] ?? '';
  const clean = firstLine.replace(/\s+/g, ' ').trim();
  if (clean.length <= 60) return clean;
  const cut = clean.slice(0, 60);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 30 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}
