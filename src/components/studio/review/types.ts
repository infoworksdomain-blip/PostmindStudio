import type { Shot } from '@/lib/client/types';

// Review-screen response shapes and the state sets the API enforces (services/projects.ts,
// services/shots.ts, services/publications.ts, pipeline/project-state.ts).

export interface SignedUrl {
  url: string;
  expiresInSec: number;
}

export interface ShotAsset {
  id: string;
  kind?: string;
  mimeType?: string;
  durationSec?: number | null;
}

export interface ShotDetail extends Shot {
  assets: ShotAsset[];
}

/** POST /projects/:id/generate accepts these (GENERATABLE_STATES). */
export const GENERATABLE = new Set([
  'DRAFT',
  'FAILED',
  'REJECTED',
  'QUALITY_FAILED',
  'READY_FOR_REVIEW',
]);
/** POST /projects/:id/cancel accepts these (ACTIVE_PIPELINE_STATES). */
export const CANCELLABLE = new Set([
  'QUEUED',
  'SCANNING',
  'PLANNING',
  'ASSETS_QUEUED',
  'ASSETS_GENERATING',
  'RENDERING',
  'QUALITY_CHECKING',
]);
/** Shot regenerate / edit (REGENERATABLE_STATES). */
export const SHOT_EDITABLE = new Set(['READY_FOR_REVIEW', 'QUALITY_FAILED', 'FAILED', 'REJECTED']);
/** POST /publications needs the project in one of these. */
export const PUBLISHABLE = new Set(['APPROVED', 'PUBLISHING', 'PUBLISHED', 'PARTIALLY_PUBLISHED']);
/** Render quality states a publication accepts. */
export const RENDER_PUBLISHABLE = new Set(['PASSED', 'FORCE_APPROVED']);

/** Render platform → connection platform (platforms/rules.ts connectionPlatform). */
export const RENDER_CONNECTION: Record<string, string> = {
  tiktok: 'tiktok',
  youtube_short: 'youtube',
  youtube: 'youtube',
  linkedin_video: 'linkedin',
  x: 'x',
  instagram_reel: 'instagram',
  facebook: 'facebook',
};
