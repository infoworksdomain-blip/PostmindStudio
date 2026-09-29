import { useSyncExternalStore } from 'react';

// In-page router for the demo build. The real app uses Next.js App Router; the demo bundles the
// same screen components into one HTML file, so routing lives in the URL hash ("#/projects/p1").
// A bare "#analytics"-style anchor (the only kind an artifact link can carry) is accepted too.

export interface Location {
  pathname: string;
  search: string;
}

const listeners = new Set<() => void>();

/** An in-page anchor inside the route ("#/settings/billing#topups"), scrolled to once it renders. */
let pendingAnchor: string | null = null;

function scrollToAnchor(): void {
  const id = pendingAnchor;
  pendingAnchor = null;
  if (!id) return;
  let tries = 0;
  const attempt = () => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ block: 'start' });
    else if (++tries < 20) window.setTimeout(attempt, 150);
  };
  window.setTimeout(attempt, 50);
}

/** A new page starts at the top, or at its anchor. */
function afterNavigation(): void {
  if (pendingAnchor) scrollToAnchor();
  else window.scrollTo({ top: 0 });
}

function parseHash(hash: string): Location {
  const [route = '', anchor] = hash.replace(/^#/, '').split('#');
  pendingAnchor = anchor || null;
  const raw = route;
  if (!raw) return { pathname: '/', search: '' };
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  const [pathname = '/', search = ''] = withSlash.split('?');
  return { pathname, search: search ? `?${search}` : '' };
}

/**
 * A hook on every location before any screen sees it (demo/tour-params.ts): tour links carry
 * `?demoPlan=` / `?lang=`, which are applied and removed here, so a screen mounts with the new
 * billing state and never fetches with the old one.
 */
export type LocationFilter = (location: Location) => Location;

let filter: LocationFilter = (location) => location;

const hashOf = (location: Location) => `#${location.pathname}${location.search}`;

function writeHistory(hash: string, replace: boolean): void {
  try {
    if (replace) window.history.replaceState(null, '', hash);
    else window.history.pushState(null, '', hash);
  } catch {
    // Some sandboxed frames refuse history writes; the in-memory route below still works.
  }
}

/** Parse, filter, and rewrite the address when the filter removed something. */
function resolve(hash: string): Location {
  const parsed = parseHash(hash);
  const next = filter(parsed);
  if (typeof window !== 'undefined' && hashOf(next) !== hashOf(parsed))
    writeHistory(hashOf(next), true);
  return next;
}

let current: Location =
  typeof window === 'undefined' ? { pathname: '/', search: '' } : parseHash(window.location.hash);

function emit(): void {
  for (const listener of listeners) listener();
}

export function setLocationFilter(next: LocationFilter): void {
  filter = next;
  if (typeof window !== 'undefined') current = resolve(window.location.hash);
}

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    current = resolve(window.location.hash);
    emit();
    afterNavigation();
  });
}

export function navigate(href: string, options: { replace?: boolean } = {}): void {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    window.open(href, '_blank', 'noopener');
    return;
  }
  const target = href.startsWith('#') ? href.slice(1) : href;
  const next = filter(parseHash(target));
  writeHistory(hashOf(next), options.replace === true);
  current = next;
  emit();
  afterNavigation();
}

export function useLocation(): Location {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => current,
  );
}

export { matchPath } from './routes';
