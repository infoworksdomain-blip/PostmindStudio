// Phase 18 §2.3 — the optimistic page guard behind src/middleware.ts: a page load inside the app
// without a session cookie is sent to /sign-in?next=<path>. It only checks that the cookie EXISTS
// (Better Auth's getSessionCookie pattern for edge middleware,
// https://www.better-auth.com/docs/integrations/next#auth-protection, read 2026-09-29); every API
// route still validates the session server-side.

/** 25.4: where a signed-in visitor lands when nothing else is asked for (was /projects). */
export const APP_HOME = '/home';

/** The signed-in app's page prefixes (the (studio) route group). */
export const PROTECTED_PAGE_PREFIXES = [
  '/account',
  '/admin',
  '/analytics',
  '/approvals',
  '/automations',
  '/blitz',
  '/business',
  '/calendar',
  '/connections',
  '/home',
  '/images',
  '/library',
  '/media',
  '/new',
  '/plans',
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
// Better Auth sends an invalid or expired email-verification link to <callbackURL>?error=<CODE>, and
// the sign-up callback is /welcome. A signed-out visitor would be bounced to a bare sign-in page with
// no hint that the link failed, so that one case goes to the verify-email screen, which explains it
// and offers a new link.
export function signInRedirectPath(pathname: string, search: string): string {
  if (pathname === '/welcome') {
    const error = new URLSearchParams(search).get('error');
    if (error && /^[A-Za-z_]{1,40}$/.test(error)) {
      return `/verify-email?error=${encodeURIComponent(error)}`;
    }
  }
  const target = `${pathname}${search}`;
  const safe = target.startsWith('/') && !target.startsWith('//') ? target : APP_HOME;
  return `/sign-in?next=${encodeURIComponent(safe)}`;
}

/** A `next` value from a query string, accepted only as a local path (no open redirect, §5.9). */
export function safeNextPath(value: string | null | undefined, fallback = APP_HOME): string {
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
