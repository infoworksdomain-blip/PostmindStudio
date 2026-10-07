import { studioModes } from '../mode';

// Phase 18 §3 — `/` is the public landing page; a visitor who is already signed in goes straight
// to /home (25.4; it was /projects). This is an optimistic hint read from the cookie NAMES only
// (the value is never verified here, the same approach as the page-load middleware): a stale
// cookie at worst lands on /home, where the real session check sends the user to sign-in.
//
// Better Auth names its session cookie `<prefix>.session_token`, with the `__Secure-` prefix on
// HTTPS (checked in the pinned better-auth@1.7.6 source, dist/cookies/index.mjs and
// cookie-utils.mjs, 2026-09-29); Studio's prefix is `studio` (§2.3). In core mode Studio has no public pages: `/` always opens the app.

export const STANDALONE_SESSION_COOKIES = [
  '__Secure-studio.session_token',
  'studio.session_token',
] as const;

export type LandingDecision = 'landing' | 'app';

export function landingDecision(
  cookieNames: readonly string[],
  env: Record<string, string | undefined> = process.env,
): LandingDecision {
  if (studioModes(env).identity === 'core') return 'app';
  return STANDALONE_SESSION_COOKIES.some((name) => cookieNames.includes(name)) ? 'app' : 'landing';
}
