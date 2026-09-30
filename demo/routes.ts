// Every hash route the demo build answers, as plain data (no React), so the tour's links can be
// checked against it in a unit test (demo/tour/links.test.ts). app.tsx types its render table
// against APP_PATHS, and public-pages.tsx answers PUBLIC_PATHS, so a path missing here is a
// compile error there.

/** Screens inside the app shell (demo/app.tsx ROUTES). */
export const APP_PATHS = [
  '/tour',
  '/tour/whats-new',
  '/tour/system',
  '/tour/not-built',
  '/tour/features',
  '/tour/workflows',
  '/tour/email/:template',
  '/new',
  '/projects',
  '/projects/:id',
  '/library',
  '/library/:id',
  '/publications',
  '/calendar',
  // 20.9 Plan my month
  '/plans',
  '/plans/new',
  '/plans/:id',
  '/analytics',
  '/analytics/publications/:id',
  '/business',
  '/connections',
  '/approvals',
  '/welcome',
  '/admin',
  '/templates',
  '/account/export',
  '/account/profile',
  '/account/security',
  '/p/:token',
  '/settings/organisation',
  '/settings/members',
  '/settings/audit',
  '/settings/billing',
] as const;

export type AppPath = (typeof APP_PATHS)[number];

/** Pages without the app shell (demo/public-pages.tsx): marketing, auth and the demo checkout. */
export const PUBLIC_PATHS = [
  '/',
  '/landing',
  '/pricing',
  '/legal/:doc',
  '/sign-up',
  '/sign-in',
  '/two-factor',
  '/verify-email',
  '/invite/:token',
  '/demo-checkout',
] as const;

/** Match "/projects/:id" against a pathname; returns params or null. */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const a = pathname.split('/').filter(Boolean);
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i] as string;
    const val = a[i] as string;
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(val);
    else if (seg !== val) return null;
  }
  return params;
}

/** The pathname and query of a tour link such as "#/settings/billing?demoPlan=past_due". */
export function splitHref(href: string): { pathname: string; search: URLSearchParams } {
  // A second "#" is an in-page anchor inside the route ("#/settings/billing#topups").
  const [raw = ''] = href.replace(/^#/, '').split('#');
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  const [pathname = '/', query = ''] = withSlash.split('?');
  return { pathname, search: new URLSearchParams(query) };
}

/** A page rendered without the app shell (demo/public-pages.tsx). */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((pattern) => matchPath(pattern, pathname) !== null);
}

/** True when the demo renders a screen (not the "No screen at …" page) for this link. */
export function isKnownRoute(href: string): boolean {
  const { pathname } = splitHref(href);
  return [...APP_PATHS, ...PUBLIC_PATHS].some((pattern) => matchPath(pattern, pathname) !== null);
}
