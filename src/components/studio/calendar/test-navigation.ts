import { useMemo, useSyncExternalStore } from 'react';

// BACKLOG 25.9 — a stand-in for next/navigation in component tests of screens that keep their
// state in the URL: router.replace / push change a shared URL and every reader re-renders.
//   vi.mock('next/navigation', async () => (await import('./test-navigation')).navigationMock);

let current = new URL('http://studio.test/calendar');
const listeners = new Set<() => void>();

export function setTestUrl(href: string): void {
  current = new URL(href, 'http://studio.test');
  for (const listener of listeners) listener();
}

export function testUrl(): URL {
  return current;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function useHref(): string {
  return useSyncExternalStore(
    subscribe,
    () => current.href,
    () => current.href,
  );
}

const router = {
  push: (href: string) => setTestUrl(href),
  replace: (href: string) => setTestUrl(href),
  back: () => undefined,
  forward: () => undefined,
  refresh: () => undefined,
  prefetch: () => undefined,
};

export const navigationMock = {
  useRouter: () => router,
  usePathname: () => new URL(useHref()).pathname,
  useSearchParams: () => {
    const href = useHref();
    return useMemo(() => new URL(href).searchParams, [href]);
  },
  useParams: () => ({}),
  redirect: (href: string) => setTestUrl(href),
  notFound: () => undefined,
};
