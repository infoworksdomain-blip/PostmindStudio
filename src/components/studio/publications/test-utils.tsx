import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { SWRConfig } from 'swr';
import { vi } from 'vitest';
import { BusinessProvider } from '../business-context';

// Test helpers shared by the publications / calendar / business / connections screens:
// a routing fetch stub that records requests, and an isolated SWR cache.

// jsdom has no ResizeObserver; Radix (checkbox, popper) measures with it.
if (typeof window !== 'undefined' && !('ResizeObserver' in window)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, writable: true });
}

export interface RecordedRequest {
  method: string;
  url: URL;
  body: unknown;
  headers: Record<string, string>;
}

export type Reply = { status?: number; body: unknown };
export type FetchHandler = (req: RecordedRequest) => Reply | undefined;

export function mockFetch(handler: FetchHandler) {
  const requests: RecordedRequest[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://studio.test');
    const raw = init?.body;
    const body: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const req: RecordedRequest = {
      method: init?.method ?? 'GET',
      url,
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    requests.push(req);
    const reply = handler(req) ?? {
      status: 404,
      body: { ok: false, error: 'not_found', message: `No mock for ${req.method} ${url.pathname}` },
    };
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return {
    fn,
    requests,
    /** Requests matching a method and a path (relative to /api/studio). */
    find: (method: string, path: string) =>
      requests.filter((r) => r.method === method && r.url.pathname === `/api/studio${path}`),
  };
}

export function renderScreen(ui: ReactElement, businessId: string | null = 'biz_1') {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <BusinessProvider initial={businessId ?? undefined}>{ui}</BusinessProvider>
    </SWRConfig>,
  );
}

export const ok = (body: Record<string, unknown>): Reply => ({ body: { ok: true, ...body } });
export const fail = (status: number, message: string, error = 'error'): Reply => ({
  status,
  body: { ok: false, error, message },
});
