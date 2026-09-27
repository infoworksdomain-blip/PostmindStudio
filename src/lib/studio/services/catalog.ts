import { z } from 'zod';
import type { PlanTier } from '../providers/router';

// Shared API vocabularies.

/** Destinations Studio renders for (spec 9.1 platforms + formats). */
export const PLATFORMS = [
  'tiktok',
  'instagram_reel',
  'youtube_short',
  'youtube',
  'linkedin_video',
  'x',
  'facebook',
] as const;

export type Platform = (typeof PLATFORMS)[number];

export const MIN_DURATION_SEC = 5;
export const MAX_DURATION_SEC = 15 * 60;

/** API shape (spec 8.2 uses durationSec). Stored in video_projects.targetFormats as spec 7.3's
 *  { platform, aspectRatio, duration }. */
export const targetFormatInput = z.object({
  platform: z.enum(PLATFORMS),
  aspectRatio: z.enum(['9:16', '16:9', '1:1', '4:5']),
  durationSec: z.number().int().min(MIN_DURATION_SEC).max(MAX_DURATION_SEC),
});

export type TargetFormatInput = z.infer<typeof targetFormatInput>;

export function toStoredFormats(formats: TargetFormatInput[]) {
  return formats.map((f) => ({
    platform: f.platform,
    aspectRatio: f.aspectRatio,
    duration: f.durationSec,
  }));
}

const TIERS: Record<string, PlanTier> = {
  basic: 'BASIC',
  standard: 'STANDARD',
  plus: 'PLUS',
  enterprise: 'ENTERPRISE',
};

/**
 * Plan tier from PostMind Core's organisation context. An unknown or missing tier routes as
 * BASIC (cheapest providers, normal priority) rather than granting paid-tier routing.
 */
export function toPlanTier(value: string | undefined): PlanTier {
  return (value && TIERS[value.trim().toLowerCase()]) || 'BASIC';
}
