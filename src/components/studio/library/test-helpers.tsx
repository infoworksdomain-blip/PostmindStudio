import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { SWRConfig } from 'swr';
import { vi } from 'vitest';
import type { LibraryVideoSummary } from './types';

// Test-only helpers for the library/analytics/admin screen tests: a routed fetch mock and an
// SWR wrapper with an isolated cache.

export interface MockRoute {
  /** Substring of the request URL (path + query) or a RegExp tested against it. */
  match: string | RegExp;
  method?: string;
  status?: number;
  body: unknown;
}

export interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

export function mockFetch(routes: MockRoute[]) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ url, method, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const route = routes.find(
      (r) =>
        (r.method ?? 'GET') === method &&
        (typeof r.match === 'string' ? url.includes(r.match) : r.match.test(url)),
    );
    if (!route)
      return new Response(
        JSON.stringify({ ok: false, error: 'not_found', message: `No mock for ${method} ${url}` }),
        { status: 404 },
      );
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

export function renderWithSWR(ui: ReactElement) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>,
  );
}

export const forbidden = {
  ok: false,
  error: 'forbidden',
  message: 'Platform staff only',
};

/** A library list item fixture. */
export function summary(over: Partial<LibraryVideoSummary> = {}): LibraryVideoSummary {
  return {
    id: 'lib_1',
    title: 'Morning coffee ritual',
    description: 'A cosy café opening',
    tags: ['coffee', 'cafe'],
    durationSec: 21,
    aspectRatio: '9:16',
    sourcePlatform: 'tiktok',
    category: { slug: 'food/cafes', name: 'Cafés' },
    analysis: {
      paceTag: 'fast-cut',
      moodTag: 'upbeat',
      structurePattern: 'hook-demo-cta',
      shotCount: 5,
    },
    allowedModes: ['TEMPLATE', 'INSPIRE'],
    thumbnailUrl: 'https://cdn.test/thumb.jpg',
    ...over,
  };
}
