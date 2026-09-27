import type { AspectRatio } from '../providers/interface';
import type { Platform } from '../services/catalog';

// Per-platform publishing rules: spec 9.1 (formats) and 9.8 (captions), tightened where the
// platform's current docs (2026-09-27) are stricter. Checked before any upload so a mismatch is
// a clear 400 instead of a failed publish.

export interface PlatformRules {
  /**
   * Where tokens come from: 'studio' = Studio-owned OAuth (refreshed by Studio); 'meta' = Meta
   * channels PostMind Core registers and refreshes via /api/studio/internal (both in platform_connections).
   */
  credentials: 'studio' | 'meta';
  /** Connection platform key in platform_connections. */
  connectionPlatform: string;
  aspectRatios: AspectRatio[];
  minDurationSec: number;
  maxDurationSec: number;
  maxBytes: number;
  captionMaxChars: number;
  /** Counted in UTF-8 bytes rather than characters (YouTube description). */
  captionLimitInBytes?: boolean;
  maxHashtags: number;
  /** Appended automatically (spec 9.4: "#Shorts" belt-and-braces). */
  requiredHashtags?: string[];
  titleMaxChars?: number;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const PLATFORM_RULES: Record<Platform, PlatformRules> = {
  // spec 9.1: 9:16, ≤10 min; TikTok media transfer guide: ≤4 GB; title ≤2200 runes.
  tiktok: {
    credentials: 'studio',
    connectionPlatform: 'tiktok',
    aspectRatios: ['9:16'],
    minDurationSec: 1,
    maxDurationSec: 600,
    maxBytes: 4 * GB,
    captionMaxChars: 2200,
    maxHashtags: 5,
  },
  // spec 9.1: 9:16; IG Reel spec: 3 s–15 min, ≤300 MB; caption ≤2200, ≤30 hashtags.
  instagram_reel: {
    credentials: 'meta',
    connectionPlatform: 'instagram',
    aspectRatios: ['9:16'],
    minDurationSec: 3,
    maxDurationSec: 900,
    maxBytes: 300 * MB,
    captionMaxChars: 2200,
    maxHashtags: 30,
  },
  // spec 9.1: Shorts 9:16 ≤3 min; description ≤5000 bytes; title ≤100 chars.
  youtube_short: {
    credentials: 'studio',
    connectionPlatform: 'youtube',
    aspectRatios: ['9:16'],
    minDurationSec: 1,
    maxDurationSec: 180,
    maxBytes: 256 * GB,
    captionMaxChars: 5000,
    captionLimitInBytes: true,
    maxHashtags: 15,
    requiredHashtags: ['Shorts'],
    titleMaxChars: 100,
  },
  // spec 9.1: long-form 16:9 ≤12 h.
  youtube: {
    credentials: 'studio',
    connectionPlatform: 'youtube',
    aspectRatios: ['16:9'],
    minDurationSec: 1,
    maxDurationSec: 12 * 3600,
    maxBytes: 256 * GB,
    captionMaxChars: 5000,
    captionLimitInBytes: true,
    maxHashtags: 15,
    titleMaxChars: 100,
  },
  // spec 9.1: 16:9 or 1:1 ≤10 min, ≤5 GB; LinkedIn Videos API spec section: 3 s–30 min, 75 KB–500 MB (stricter used).
  linkedin_video: {
    credentials: 'studio',
    connectionPlatform: 'linkedin',
    aspectRatios: ['16:9', '1:1'],
    minDurationSec: 3,
    maxDurationSec: 600,
    maxBytes: 500 * MB,
    captionMaxChars: 3000,
    maxHashtags: 5,
  },
  // spec 9.1: 16:9 or 1:1; spec 9.8: 280 chars (Basic). X docs: tweet_video 0.5 s–20 min default.
  x: {
    credentials: 'studio',
    connectionPlatform: 'x',
    aspectRatios: ['16:9', '1:1'],
    minDurationSec: 1,
    maxDurationSec: 140,
    maxBytes: 8 * GB,
    captionMaxChars: 280,
    maxHashtags: 2,
  },
  // Facebook Reels only (spec 9.7; FB Reels docs: 9:16, 3–90 s). Feed-video upload is not built.
  facebook: {
    credentials: 'meta',
    connectionPlatform: 'facebook',
    aspectRatios: ['9:16'],
    minDurationSec: 3,
    maxDurationSec: 90,
    maxBytes: 1 * GB,
    captionMaxChars: 63206,
    maxHashtags: 5,
  },
};

export interface FormatCheckInput {
  aspectRatio: string;
  durationSec: number;
  sizeBytes?: number;
}

/** Human-readable problems with publishing this render to this platform (empty = OK). */
export function checkFormat(platform: Platform, input: FormatCheckInput): string[] {
  const rules = PLATFORM_RULES[platform];
  const problems: string[] = [];
  if (!rules.aspectRatios.includes(input.aspectRatio as AspectRatio)) {
    problems.push(
      `${platform} needs ${rules.aspectRatios.join(' or ')} (render is ${input.aspectRatio})`,
    );
  }
  if (input.durationSec < rules.minDurationSec || input.durationSec > rules.maxDurationSec) {
    problems.push(
      `${platform} accepts ${rules.minDurationSec}–${rules.maxDurationSec}s (render is ${input.durationSec.toFixed(1)}s)`,
    );
  }
  if (input.sizeBytes !== undefined && input.sizeBytes > rules.maxBytes) {
    problems.push(`${platform} accepts files up to ${Math.floor(rules.maxBytes / MB)} MB`);
  }
  return problems;
}
