import { LEGAL_DOCS } from '@/lib/legal/documents';
import { PROTECTED_PAGE_PREFIXES } from '@/lib/auth/page-guard';

// The public origin for robots.txt and sitemap.xml: APP_URL (the same value Better Auth trusts),
// without a trailing slash; localhost when unset (dev and tests).
export function siteOrigin(env: Record<string, string | undefined> = process.env): string {
  const raw = env.APP_URL?.trim() || env.BETTER_AUTH_URL?.trim() || 'http://localhost:3000';
  try {
    return new URL(raw).origin;
  } catch {
    return 'http://localhost:3000';
  }
}

// 26.2: when each public page's content last changed meaningfully (the sitemap's <lastmod>). Bump
// the date when a page's copy changes; legal documents also carry their own "last updated" line.
const LAST_MODIFIED: Record<string, string> = {
  '/': '2026-10-09',
  '/pricing': '2026-10-09',
  '/sign-in': '2026-10-07',
  '/sign-up': '2026-10-07',
};
const LEGAL_LAST_MODIFIED = '2026-10-04';

/** Public, indexable paths: the marketing pages, sign-in/up and the six legal documents. */
export function publicPaths(): string[] {
  return [...Object.keys(LAST_MODIFIED), ...LEGAL_DOCS.map((doc) => `/legal/${doc}`)];
}

export function lastModified(path: string): string {
  return LAST_MODIFIED[path] ?? LEGAL_LAST_MODIFIED;
}

/**
 * Paths crawlers must stay out of: the API, the signed-in app, shared review links, Meta
 * callbacks. robots.txt rules are prefix matches, so "/projects" also covers "/projects/…".
 */
export function disallowedPaths(): string[] {
  return ['/api/', ...PROTECTED_PAGE_PREFIXES, '/p/', '/meta/'];
}
