import type { PlatformConnection } from '@/lib/client/types';

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
  { platform: 'youtube_short', aspectRatio: '9:16', shortSec: 30, longSec: 60 },
  { platform: 'youtube', aspectRatio: '16:9', shortSec: 60, longSec: 300 },
  { platform: 'linkedin_video', aspectRatio: '16:9', shortSec: 30, longSec: 120 },
  { platform: 'x', aspectRatio: '16:9', shortSec: 30, longSec: 120 },
  { platform: 'facebook', aspectRatio: '9:16', shortSec: 30, longSec: 90 },
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
};

/** Pre-select platforms the business has connected; TikTok when nothing is connected yet. */
export function defaultPlatforms(
  connections: PlatformConnection[] | undefined,
  businessId: string | null,
): string[] {
  const connected = (connections ?? [])
    .filter((c) => c.state === 'active' && (!businessId || c.businessId === businessId))
    .flatMap((c) => CONNECTION_PLATFORMS[c.platform] ?? []);
  const unique = [...new Set(connected)];
  return unique.length ? unique : ['tiktok'];
}

/** A project name from the brief: its first line, trimmed to a sensible length. */
export function nameFromBrief(brief: string): string {
  const firstLine = brief.trim().split(/\r?\n/)[0] ?? '';
  const clean = firstLine.replace(/\s+/g, ' ').trim();
  if (clean.length <= 60) return clean || 'Untitled video';
  const cut = clean.slice(0, 60);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 30 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}
