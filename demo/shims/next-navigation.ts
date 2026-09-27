import { useMemo } from 'react';
import { navigate, useLocation } from '../router';

// Stand-in for next/navigation in the demo bundle.

export function useRouter() {
  return useMemo(
    () => ({
      push: (href: string) => navigate(href),
      replace: (href: string) => navigate(href, { replace: true }),
      back: () => window.history.back(),
      forward: () => window.history.forward(),
      refresh: () => undefined,
      prefetch: () => undefined,
    }),
    [],
  );
}

export function usePathname(): string {
  return useLocation().pathname;
}

export function useSearchParams(): URLSearchParams {
  const { search } = useLocation();
  return useMemo(() => new URLSearchParams(search), [search]);
}

export function useParams(): Record<string, string> {
  return {};
}

export function redirect(href: string): never {
  navigate(href, { replace: true });
  throw new Error(`redirect to ${href}`);
}

export function notFound(): never {
  throw new Error('not found');
}
