import { getSessionCookie } from 'better-auth/cookies';
import { NextResponse, type NextRequest } from 'next/server';
import { AUTH_COOKIE_PREFIX } from './lib/auth/cookie';
import { isProtectedPage, pageGuardEnabled, signInRedirectPath } from './lib/auth/page-guard';

// Phase 18 §2.3: optimistic redirect of signed-out page loads to /sign-in (edge runtime; no
// database). The real check is server-side in every API route and page data call.

export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  if (!pageGuardEnabled(process.env) || !isProtectedPage(pathname)) return NextResponse.next();
  if (process.env.NODE_ENV === 'development' && process.env.STUDIO_DEV_TENANT?.trim()) {
    return NextResponse.next();
  }
  if (getSessionCookie(request, { cookiePrefix: AUTH_COOKIE_PREFIX })) return NextResponse.next();
  return NextResponse.redirect(new URL(signInRedirectPath(pathname, search), request.url));
}

export const config = {
  // Pages only: API routes, Next internals and files with an extension are never matched.
  matcher: ['/((?!api/|_next/|p/|.*\.[a-zA-Z0-9]+$).*)'],
};
