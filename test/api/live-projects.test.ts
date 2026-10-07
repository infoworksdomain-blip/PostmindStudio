import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as liveRoute from '../../src/app/api/studio/live/projects/route';
import * as statusRoute from '../../src/app/api/studio/live/projects/status/route';
import { UnauthorizedError } from '../../src/lib/errors';
import { setApiDeps, type ApiDeps } from '../../src/lib/studio/api/context';
import { createMemoryProjectEventBus } from '../../src/lib/studio/live/events';
import type { TenantContext } from '../../src/lib/tenant';
import { call, rawCall, tenant } from '../helpers/api-harness';

// 24.2 — GET /api/studio/live/projects (SSE) and /live/projects/status: authentication,
// capability, and organisation isolation (a member only ever hears about their own
// organisation's projects, even when another organisation's project id is announced on their
// channel). No database: the project table is a small in-memory stand-in.

interface Row {
  id: string;
  organisationId: string;
  state: string;
  sourceType: string;
  metadata: unknown;
  deletedAt: null;
}

const ROWS: Row[] = [
  {
    id: 'pa',
    organisationId: 'org_a',
    state: 'RENDERING',
    sourceType: 'SLIDESHOW',
    metadata: {},
    deletedAt: null,
  },
  {
    id: 'pb',
    organisationId: 'org_b',
    state: 'RENDERING',
    sourceType: 'BRIEF',
    metadata: {},
    deletedAt: null,
  },
];

function install(options: { bus?: boolean } = {}) {
  const bus = createMemoryProjectEventBus();
  const tokens: Record<string, TenantContext> = {
    a: tenant('org_a'),
    b: tenant('org_b'),
    noread: tenant('org_a', ['studio:publication:write']),
  };
  const db = {
    videoProject: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] }; organisationId: string } }) =>
        ROWS.filter(
          (r) => args.where.id.in.includes(r.id) && r.organisationId === args.where.organisationId,
        ),
      ),
    },
    videoRender: { findFirst: vi.fn(async () => null) },
  };
  const deps = {
    db,
    storage: { signedUrl: vi.fn(async () => 'https://cdn.test/x') },
    resolveTenant: vi.fn(async (req: Pick<Request, 'headers'>) => {
      const token = req.headers.get('authorization')?.replace(/^Bearer /, '');
      const entry = token ? tokens[token] : undefined;
      if (!entry) throw new UnauthorizedError('Missing or invalid token');
      return entry;
    }),
    audit: () => undefined,
    logger: pino({ level: 'silent' }),
    now: () => Date.parse('2026-10-06T10:00:00Z'),
    ...(options.bus !== false && { liveEvents: bus }),
  } as unknown as ApiDeps;
  setApiDeps(deps);
  return { bus, db };
}

async function readUntil(res: Response, needle: string, max = 20): Promise<string> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (let i = 0; i < max && !text.includes(needle); i += 1) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  reader.releaseLock();
  return text;
}

afterEach(() => setApiDeps(undefined));

describe('GET /api/studio/live/projects', () => {
  it('needs a session and studio:project:read', async () => {
    install();
    expect((await rawCall(liveRoute.GET)).status).toBe(401);
    expect((await rawCall(liveRoute.GET, { token: 'noread' })).status).toBe(403);
  });

  it('answers 503 without an event bus (the browser falls back to polling)', async () => {
    install({ bus: false });
    const res = await call(liveRoute.GET, { token: 'a' });
    expect(res.status).toBe(503);
    expect(res.json.error).toBe('live_unavailable');
  });

  it("streams only the member's own organisation's projects", async () => {
    const { bus } = install();
    const abortA = new AbortController();
    const abortB = new AbortController();
    const resA = await rawCall(liveRoute.GET, { token: 'a', signal: abortA.signal });
    const resB = await rawCall(liveRoute.GET, { token: 'b', signal: abortB.signal });
    expect(resA.status).toBe(200);
    expect(resA.headers.get('content-type')).toContain('text/event-stream');
    expect(resA.headers.get('x-correlation-id')).toBeTruthy();
    await readUntil(resA, 'event: ready');
    await readUntil(resB, 'event: ready');

    // org_b's change goes to org_b only; a forged org_b id on org_a's channel is dropped
    // (the snapshot is scoped to org_a), then org_a's own project arrives.
    await bus.publish('org_b', { projectId: 'pb' });
    await bus.publish('org_a', { projectId: 'pb' });
    await bus.publish('org_a', { projectId: 'pa' });
    const a = await readUntil(resA, '"pa"');
    const b = await readUntil(resB, '"pb"');
    expect(a).toContain('"projectId":"pa"');
    expect(a).not.toContain('"pb"');
    expect(b).toContain('"projectId":"pb"');
    expect(b).not.toContain('"pa"');
    expect(a).toContain('"stage":"composing"');

    abortA.abort();
    abortB.abort();
    await vi.waitFor(() => {
      expect(bus.listenerCount('org_a')).toBe(0);
      expect(bus.listenerCount('org_b')).toBe(0);
    });
  });
});

describe('GET /api/studio/live/projects/status', () => {
  it("returns the caller's projects only and validates ids", async () => {
    install();
    const res = await call(statusRoute.GET, {
      token: 'a',
      path: '/api/studio/live/projects/status?ids=pa,pb',
    });
    expect(res.status).toBe(200);
    expect((res.json.projects as Array<{ projectId: string }>).map((p) => p.projectId)).toEqual([
      'pa',
    ]);
    const bad = await call(statusRoute.GET, {
      token: 'a',
      path: '/api/studio/live/projects/status',
    });
    expect(bad.status).toBe(400);
    expect(
      (await call(statusRoute.GET, { path: '/api/studio/live/projects/status?ids=pa' })).status,
    ).toBe(401);
  });
});
