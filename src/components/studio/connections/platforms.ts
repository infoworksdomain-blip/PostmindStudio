import type { PlatformConnection } from '@/lib/client/types';

// Platforms Studio connects itself (OAuth, spec 8.6). Instagram and Facebook are connected in
// PostMind settings: PostMind Core runs the Meta login and registers the accounts with Studio
// (POST /api/studio/internal/channels), so Studio lists them read-only.

export type OAuthPlatform = Exclude<PlatformConnection['platform'], MetaPlatform>;
export type MetaPlatform = 'instagram' | 'facebook';

// `posts` is the en-GB description; screens show connections.posts.<id>.
export const OAUTH_PLATFORMS: Array<{ id: OAuthPlatform; label: string; posts: string }> = [
  { id: 'tiktok', label: 'TikTok', posts: 'Short vertical videos' },
  { id: 'youtube', label: 'YouTube', posts: 'Shorts and long-form videos' },
  { id: 'x', label: 'X', posts: 'Video posts' },
  { id: 'linkedin', label: 'LinkedIn', posts: 'Company and member video posts' },
];

export const META_PLATFORMS: Array<{ id: MetaPlatform; label: string; posts: string }> = [
  { id: 'instagram', label: 'Instagram', posts: 'Reels and feed videos' },
  { id: 'facebook', label: 'Facebook', posts: 'Page Reels and feed videos' },
];

/**
 * Where users connect Instagram / Facebook (PostMind Core owns the Meta login). en-GB text of
 * connections.meta.guidance — localised screens use that key.
 */
export const META_CONNECT_GUIDANCE = 'Connect Instagram and Facebook in PostMind settings.';

export function isMetaPlatform(platform: string): platform is MetaPlatform {
  return platform === 'instagram' || platform === 'facebook';
}

/** A connection is usable for a business when it is that business's or organisation-wide. */
export function belongsToBusiness(
  connection: Pick<PlatformConnection, 'businessId'>,
  businessId: string | null,
): boolean {
  return !businessId || !connection.businessId || connection.businessId === businessId;
}

/** Error codes the OAuth callback can put in ?connection_error= (StudioError codes). */
export const CALLBACK_ERROR_CODES = [
  'validation_error',
  'platform_error',
  'upstream_error',
  'internal_error',
] as const;

export type CallbackErrorCode = (typeof CALLBACK_ERROR_CODES)[number];

/** A known callback error code (connections.callbackErrors.<code>), or null for an unknown one. */
export function callbackErrorCode(code: string): CallbackErrorCode | null {
  return (CALLBACK_ERROR_CODES as readonly string[]).includes(code)
    ? (code as CallbackErrorCode)
    : null;
}

export function platformLabel(id: string): string {
  return [...OAUTH_PLATFORMS, ...META_PLATFORMS].find((p) => p.id === id)?.label ?? id;
}
