import { useSyncExternalStore } from 'react';

// In-page router for the demo build. The real app uses Next.js App Router; the demo bundles the
// same screen components into one HTML file, so routing lives in the URL hash ("#/projects/p1").
// A bare "#analytics"-style anchor (the only kind an artifact link can carry) is accepted too.

export interface Location {
  pathname: string;
  search: string;
}

const listeners = new Set<() => void>();

function parseHash(hash: string): Location {
  const raw = hash.replace(/^#/, '');
  if (!raw) return { pathname: '/', search: '' };
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  const [pathname = '/', search = ''] = withSlash.split('?');
  return { pathname, search: search ? `?${search}` : '' };
}

let current: Location =
  typeof window === 'undefined' ? { pathname: '/', search: '' } : parseHash(window.location.hash);

function emit(): void {
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    current = parseHash(window.location.hash);
    emit();
    window.scrollTo({ top: 0 });
  });
}

export function navigate(href: string, options: { replace?: boolean } = {}): void {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    window.open(href, '_blank', 'noopener');
    return;
  }
  const target = href.startsWith('#') ? href.slice(1) : href;
  const next = parseHash(target);
  const hash = `#${next.pathname}${next.search}`;
  try {
    if (options.replace) window.history.replaceState(null, '', hash);
    else window.history.pushState(null, '', hash);
  } catch {
    // Some sandboxed frames refuse history writes; the in-memory route below still works.
  }
  current = next;
  emit();
  window.scrollTo({ top: 0 });
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
