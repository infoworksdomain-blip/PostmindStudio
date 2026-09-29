// Phase 18 §2.3 — the optimistic page guard behind src/middleware.ts: a page load inside the app
// without a session cookie is sent to /sign-in?next=<path>. It only checks that the cookie EXISTS
// (Better Auth's getSessionCookie pattern for edge middleware,
// https://www.better-auth.com/docs/integrations/next#auth-protection, read 2026-09-29); every API
// route still validates the session server-side.

/** The signed-in app's page prefixes (the (studio) route group). */
export const PROTECTED_PAGE_PREFIXES = [
  '/account',
  '/admin',
  '/analytics',
  '/approvals',
  '/business',
  '/calendar',
  '/connections',
  '/library',
  '/new',
  '/projects',
  '/publications',
  '/settings',
  '/templates',
  '/welcome',
] as const;

export function isProtectedPage(pathname: string): boolean {
  return PROTECTED_PAGE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Where to send a signed-out visitor; `next` is always a same-site relative path. */
export function signInRedirectPath(pathname: string, search: string): string {
  const target = `${pathname}${search}`;
  const safe = target.startsWith('/') && !target.startsWith('//') ? target : '/projects';
  return `/sign-in?next=${encodeURIComponent(safe)}`;
}

/** A `next` value from a query string, accepted only as a local path (no open redirect, §5.9). */
export function safeNextPath(value: string | null | undefined, fallback = '/projects'): string {
  if (!value) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  try {
    const url = new URL(value, 'https://studio.invalid');
    return url.origin === 'https://studio.invalid' ? `${url.pathname}${url.search}` : fallback;
  } catch {
    return fallback;
  }
}

/** Standalone identity is on unless STUDIO_MODE / STUDIO_IDENTITY_MODE pick core. */
export function pageGuardEnabled(env: Record<string, string | undefined>): boolean {
  const identity = env.STUDIO_IDENTITY_MODE?.trim().toLowerCase();
  if (identity) return identity === 'standalone';
  return (env.STUDIO_MODE?.trim().toLowerCase() || 'standalone') === 'standalone';
}
