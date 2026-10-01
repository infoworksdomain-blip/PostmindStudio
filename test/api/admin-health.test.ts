import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as providersRoute from '../../src/app/api/studio/admin/providers/route';
import * as queuesRoute from '../../src/app/api/studio/admin/queues/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import {
  createCircuitBreaker,
  FAILURE_THRESHOLD,
} from '../../src/lib/studio/providers/circuit-breaker';
import { utcDay } from '../../src/lib/studio/providers/job-repository';
import type { InspectableQueue } from '../../src/lib/studio/services/admin-health';
import { call, installApi, tenant } from '../helpers/api-harness';

// BACKLOG 13.16 — GET /admin/queues and GET /admin/providers: staff only, the shared breaker
// state, the last hour's error rate from provider_jobs and today's spend from provider_usage.

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('admin queue and provider health API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const staffOrg = `api-health-staff-${randomUUID()}`;
  const org = `api-health-org-${randomUUID()}`;
  const provider = `prov-${randomUUID().slice(0, 8)}`;
  const tokens = {
    staff: tenant(staffOrg, ['studio:admin:providers']),
    outsider: tenant(org, ['studio:admin:providers']),
    noCapability: tenant(staffOrg, ['studio:project:read']),
  };
  let api: ReturnType<typeof installApi>;

  beforeEach(() => {
    api = installApi(db, tokens);
    vi.stubEnv('STUDIO_PLATFORM_ORG_IDS', staffOrg);
  });

  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    setApiDeps(undefined);
    await db.providerJob.deleteMany({ where: { organisationId: org } });
    await db.providerUsage.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  it('refuses non-staff organisations and callers without the capability', async () => {
    expect((await call(queuesRoute.GET, { token: 'outsider' })).status).toBe(403);
    expect((await call(providersRoute.GET, { token: 'outsider' })).status).toBe(403);
    expect((await call(providersRoute.GET, { token: 'noCapability' })).status).toBe(403);
    expect((await call(queuesRoute.GET, {})).status).toBe(401);
  });

  it('GET /admin/queues reports depth and the oldest waiting job per queue', async () => {
    const now = Date.now();
    const fake: InspectableQueue = {
      name: 'studio-assets',
      getJobCounts: async () => ({ waiting: 12, prioritized: 2, active: 5, failed: 2, delayed: 0 }),
      getJobs: async (types) => (types[0] === 'wait' ? [{ timestamp: now - 41_000 }] : []),
    };
    api.deps.adminQueues = () => [fake];
    const res = await call(queuesRoute.GET, { token: 'staff' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      ok: true,
      queues: [{ name: 'studio-assets', waiting: 14, active: 5, failed: 2, delayed: 0 }],
    });
    const [q] = res.json.queues as Array<{ oldestWaitingSec: number }>;
    expect(q?.oldestWaitingSec).toBeGreaterThanOrEqual(40);
  });

  it('GET /admin/providers joins the breaker, last-hour jobs and spend today', async () => {
    const breaker = createCircuitBreaker();
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) breaker.recordFailure(provider);
    api.deps.breaker = breaker;
    const base = { organisationId: org, provider, operation: 'text_to_video', requestBody: {} };
    await db.providerJob.createMany({
      data: [
        { ...base, state: 'SUCCEEDED' },
        { ...base, state: 'SUCCEEDED' },
        { ...base, state: 'FAILED', errorClass: 'provider_error' },
        { ...base, state: 'FAILED', errorClass: 'content_policy' },
        // Two hours ago: outside the window.
        {
          ...base,
          state: 'FAILED',
          errorClass: 'timeout',
          startedAt: new Date(Date.now() - 7_200_000),
        },
      ],
    });
    await db.providerUsage.create({
      data: {
        organisationId: org,
        provider,
        day: utcDay(new Date()),
        jobCount: 4,
        costPence: 1_840,
      },
    });
    const res = await call(providersRoute.GET, { token: 'staff' });
    expect(res.status).toBe(200);
    const row = (res.json.providers as Array<Record<string, unknown>>).find(
      (p) => p.id === provider,
    );
    expect(row).toEqual({
      id: provider,
      configured: false,
      breaker: 'open',
      errorRate1h: 0.25,
      jobs1h: { succeeded: 2, failed: 2, running: 0 },
      spendTodayPence: 1_840,
      accountHold: null,
      healthy: false,
    });
    // The harness registry's runway adapter is listed as configured.
    expect(
      (res.json.providers as Array<Record<string, unknown>>).find((p) => p.id === 'runway'),
    ).toMatchObject({ configured: true });
  });
});
