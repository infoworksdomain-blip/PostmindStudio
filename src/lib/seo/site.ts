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

/** Public, indexable paths: the marketing pages and the six legal documents. */
export function publicPaths(): string[] {
  return ['/', '/pricing', ...LEGAL_DOCS.map((doc) => `/legal/${doc}`)];
}

/** Paths crawlers must stay out of: the API, the signed-in app, shared review links, Meta callbacks. */
export function disallowedPaths(): string[] {
  return ['/api/', ...PROTECTED_PAGE_PREFIXES.map((p) => `${p}/`), '/p/', '/meta/'].concat(
    PROTECTED_PAGE_PREFIXES.map((p) => p),
  );
}
