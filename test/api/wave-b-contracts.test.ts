import type { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as businessesRoute from '../../src/app/api/studio/businesses/route';
import * as reconciliationRoute from '../../src/app/api/studio/admin/channels/reconciliation/route';
import { studioModes } from '../../src/lib/mode';
import { setApiDeps, type ApiDeps } from '../../src/lib/studio/api/context';
import type { CoreBusinessDirectory } from '../../src/lib/studio/core/business-directory';
import type { CoreChannelDirectory } from '../../src/lib/studio/core/channel-directory';
import { call, installApi, tenant } from '../helpers/api-harness';

// BACKLOG 13.34 / 13.35 (Wave B): the endpoints ship with their final contracts and answer an
// honest 501 until PostMind Core publishes list-businesses / list-channels. Phase 18: that is
// core mode (STUDIO_MODE=core); standalone lists studio.businesses (test/api/p18-businesses.test.ts). No database needed:
// the 501 paths never query, and the "Core shipped" paths use an in-memory platformConnection.

const STAFF_ORG = 'wave-b-staff';
const ORG = 'wave-b-org';

const channels = [
  {
    id: 'c1',
    organisationId: ORG,
    platform: 'instagram',
    platformAccountId: '1001',
    platformAccountName: '@bakery',
    state: 'active',
  },
];

function fakeDb() {
  return {
    platformConnection: {
      findMany: vi.fn(async ({ where }: { where: { organisationId?: string } }) =>
        channels.filter((c) => !where.organisationId || c.organisationId === where.organisationId),
      ),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };
}

const tokens = {
  reader: tenant(ORG, ['studio:project:read']),
  noRead: tenant(ORG, ['studio:publication:write']),
  staff: tenant(STAFF_ORG, ['studio:admin:providers']),
  staffNoCap: tenant(STAFF_ORG, ['studio:project:read']),
  outsider: tenant(ORG, ['studio:admin:providers']),
};

let deps: ApiDeps;
let db: ReturnType<typeof fakeDb>;

beforeEach(() => {
  db = fakeDb();
  deps = {
    ...installApi(db as unknown as PrismaClient, tokens).deps,
    modes: studioModes({ STUDIO_MODE: 'core' }),
  };
  setApiDeps(deps);
  vi.stubEnv('STUDIO_PLATFORM_ORG_IDS', STAFF_ORG);
});

afterEach(() => {
  vi.unstubAllEnvs();
  setApiDeps(undefined);
});

function withCore(core: NonNullable<ApiDeps['core']>) {
  setApiDeps({ ...deps, core });
}

describe('GET /api/studio/businesses', () => {
  const get = (token?: string) =>
    call(businessesRoute.GET, { path: '/api/studio/businesses', token });

  it('requires a session and studio:project:read', async () => {
    expect((await get()).status).toBe(401);
    expect((await get('noRead')).status).toBe(403);
  });

  it('answers 501 waiting for Core list-businesses', async () => {
    const res = await get('reader');
    expect(res.status).toBe(501);
    expect(res.json).toEqual({
      ok: false,
      error: 'not_implemented',
      message: 'waiting for Core list-businesses (GET /api/internal/organisations/:id/businesses)',
    });
  });

  it('returns Core’s list for the caller’s organisation once Core ships it', async () => {
    const directory: CoreBusinessDirectory = {
      listBusinesses: vi.fn(async () => [
        { id: 'biz_1', name: 'Leeds Sourdough', domain: 'leedssourdough.co.uk' },
        { id: 'biz_2', name: 'Market stall' },
      ]),
    };
    withCore({ businesses: directory });
    const res = await get('reader');
    expect(res.status).toBe(200);
    expect(directory.listBusinesses).toHaveBeenCalledWith(ORG);
    expect(res.json).toEqual({
      ok: true,
      data: [
        { id: 'biz_1', name: 'Leeds Sourdough', domain: 'leedssourdough.co.uk' },
        { id: 'biz_2', name: 'Market stall' },
      ],
      local: false,
    });
  });
});

describe('GET /api/studio/admin/channels/reconciliation', () => {
  const get = (token?: string, query = '') =>
    call(reconciliationRoute.GET, {
      path: `/api/studio/admin/channels/reconciliation${query}`,
      token,
    });

  it('is for PostMind staff with studio:admin:providers only', async () => {
    expect((await get()).status).toBe(401);
    expect((await get('staffNoCap')).status).toBe(403);
    const outsider = await get('outsider');
    expect(outsider.status).toBe(403);
    expect(outsider.json.message).toMatch(/staff/);
  });

  it('answers staff 501 waiting for Core list-channels, without reading channels', async () => {
    const res = await get('staff');
    expect(res.status).toBe(501);
    expect(res.json).toEqual({
      ok: false,
      error: 'not_implemented',
      message: 'waiting for Core list-channels (GET /api/internal/organisations/:id/channels)',
    });
    expect(db.platformConnection.findMany).not.toHaveBeenCalled();
  });

  it('is not applicable in standalone mode (Studio owns the Meta login)', async () => {
    setApiDeps({ ...deps, modes: studioModes({}) });
    const res = await get('staff');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, applicable: false });
    expect(res.json.message).toMatch(/Not applicable in standalone mode/);
    expect(db.platformConnection.findMany).not.toHaveBeenCalled();
  });

  it('validates the organisationId filter', async () => {
    const res = await get('staff', `?organisationId=${'x'.repeat(200)}`);
    expect(res.status).toBe(400);
  });

  it('reports without applying once Core ships list-channels', async () => {
    const directory: CoreChannelDirectory = { ready: true, listChannels: vi.fn(async () => []) };
    withCore({ channels: directory });
    const res = await get('staff', `?organisationId=${ORG}`);
    expect(res.status).toBe(200);
    const report = res.json.report as {
      applied: boolean;
      totals: Record<string, number>;
      organisations: Array<{ findings: Array<{ kind: string; action: string }> }>;
    };
    expect(report.applied).toBe(false);
    expect(report.organisations[0]?.findings).toEqual([
      expect.objectContaining({ kind: 'missing_in_core', action: 'disconnect' }),
    ]);
    expect(db.platformConnection.updateMany).not.toHaveBeenCalled();
  });
});
