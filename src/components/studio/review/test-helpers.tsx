import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { SWRConfig } from 'swr';
import { vi } from 'vitest';
import { BusinessProvider } from '../business-context';
import type { ProjectDetail, Render } from '@/lib/client/types';

// Test-only helpers for the Create / Review / Slideshow / Overlay screens: a routed fetch mock
// that records every request, and an isolated SWR + business-context render.

export interface MockRoute {
  method?: string;
  /** Path under /api/studio (exact pathname match) or a RegExp over the full URL. */
  match: string | RegExp;
  status?: number;
  body: unknown;
}

export interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string>;
}

export function mockFetch(routes: MockRoute[]) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({
      method,
      path: url.pathname.replace(/^\/api\/studio/, ''),
      query: url.searchParams,
      body: raw ? (JSON.parse(raw) as unknown) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const route = routes.find(
      (r) =>
        (r.method ?? 'GET').toUpperCase() === method &&
        (typeof r.match === 'string'
          ? url.pathname === `/api/studio${r.match}`
          : r.match.test(url.toString())),
    );
    if (!route)
      return new Response(JSON.stringify({ ok: false, error: 'not_found', message: 'No mock' }), {
        status: 404,
      });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    fetchMock,
    find: (method: string, path: string) =>
      calls.filter((c) => c.method === method && c.path === path),
  };
}

export function renderWithSWR(ui: ReactElement, businessId = 'biz_1'): RenderResult {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <BusinessProvider initial={businessId}>{ui}</BusinessProvider>
    </SWRConfig>,
  );
}

export function makeRender(over: Partial<Render> = {}): Render {
  return {
    id: 'ren_1',
    projectId: 'proj_1',
    scriptId: 'scr_1',
    targetPlatform: 'tiktok',
    aspectRatio: '9:16',
    resolution: '1080x1920',
    durationSec: 12,
    qualityCheckState: 'PASSED',
    qualityIssues: [],
    costPence: 120,
    createdAt: '2026-09-26T10:00:00.000Z',
    ...over,
  };
}

export function makeProject(over: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    id: 'proj_1',
    organisationId: 'org_1',
    businessId: 'biz_1',
    name: 'Spring menu launch',
    description: 'Spring menu',
    state: 'READY_FOR_REVIEW',
    sourceType: 'BRIEF',
    referenceVideoId: null,
    referenceMode: null,
    targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 30 }],
    brandKitId: null,
    costBudgetPence: null,
    costActualPence: 450,
    reviewPolicy: 'REQUIRE_APPROVAL',
    publishPolicy: 'MANUAL',
    errorReason: null,
    metadata: null,
    createdAt: '2026-09-26T09:00:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
    completedAt: null,
    brief: {
      hook: 'Three new plates',
      keyMessage: 'Spring menu',
      targetAudience: 'Locals',
      tone: 'Warm',
    },
    scripts: [
      {
        id: 'scr_1',
        projectId: 'proj_1',
        targetPlatform: 'tiktok',
        targetAspectRatio: '9:16',
        targetDurationSec: 12,
        fullText: 'Spring is here. Three new plates.',
        scriptModel: 'claude',
        shots: [
          {
            id: 'shot_1',
            sortOrder: 0,
            durationSec: 5,
            visualTreatment: 'AI_CLIP',
            state: 'READY',
            errorReason: null,
          },
          {
            id: 'shot_2',
            sortOrder: 1,
            durationSec: 7,
            visualTreatment: 'STOCK_FOOTAGE',
            state: 'READY',
            errorReason: null,
          },
        ],
      },
    ],
    renders: [makeRender()],
    publications: [],
    approvals: [],
    ...over,
  };
}
