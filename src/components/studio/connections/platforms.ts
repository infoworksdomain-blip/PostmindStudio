import type { PlatformConnection } from '@/lib/client/types';

// Platforms Studio connects itself (OAuth, spec 8.6). Instagram and Facebook reuse the
// Engagement service's Meta connection (spec 9.3) and are managed there.

export type OAuthPlatform = PlatformConnection['platform'];

export const OAUTH_PLATFORMS: Array<{ id: OAuthPlatform; label: string; posts: string }> = [
  { id: 'tiktok', label: 'TikTok', posts: 'Short vertical videos' },
  { id: 'youtube', label: 'YouTube', posts: 'Shorts and long-form videos' },
  { id: 'x', label: 'X', posts: 'Video posts' },
  { id: 'linkedin', label: 'LinkedIn', posts: 'Company and member video posts' },
];

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
  return OAUTH_PLATFORMS.find((p) => p.id === id)?.label ?? id;
}
