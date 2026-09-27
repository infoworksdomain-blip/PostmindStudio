import type { PlatformConnection } from '@/lib/client/types';

// Platforms Studio connects itself (OAuth, spec 8.6). Instagram and Facebook are connected in
// PostMind settings: PostMind Core runs the Meta login and registers the accounts with Studio
// (POST /api/studio/internal/channels), so Studio lists them read-only.

export type OAuthPlatform = Exclude<PlatformConnection['platform'], MetaPlatform>;
export type MetaPlatform = 'instagram' | 'facebook';

export const OAUTH_PLATFORMS: Array<{ id: OAuthPlatform; label: string; posts: string }> = [
  { id: 'tiktok', label: 'TikTok', posts: 'Short vertical videos' },
  { id: 'youtube', label: 'YouTube', posts: 'Shorts and long-form videos' },
  { id: 'x', label: 'X', posts: 'Video posts' },
  { id: 'linkedin', label: 'LinkedIn', posts: 'Company and member video posts' },
];

export const META_PLATFORMS: Array<{ id: MetaPlatform; label: string; posts: string }> = [
  { id: 'instagram', label: 'Instagram', posts: 'Reels' },
  { id: 'facebook', label: 'Facebook', posts: 'Page Reels' },
];

/** Where users connect Instagram / Facebook (PostMind Core owns the Meta login). */
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
const CALLBACK_ERRORS: Record<string, string> = {
  validation_error:
    'The platform did not grant access (the request was declined or returned an error). Try connecting again.',
  platform_error: 'The platform had a problem completing the connection. Try again shortly.',
  upstream_error: 'The platform had a problem completing the connection. Try again shortly.',
  internal_error: 'Something went wrong finishing the connection. Try again.',
};

export function callbackErrorMessage(code: string): string {
  return CALLBACK_ERRORS[code] ?? `The connection did not complete (${code}). Try again.`;
}

export function platformLabel(id: string): string {
  return [...OAUTH_PLATFORMS, ...META_PLATFORMS].find((p) => p.id === id)?.label ?? id;
}
