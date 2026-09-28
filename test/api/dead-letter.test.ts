import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as requeueRoute from '../../src/app/api/studio/admin/queues/[name]/failed/[jobId]/requeue/route';
import * as retryRoute from '../../src/app/api/studio/admin/queues/[name]/failed/[jobId]/retry/route';
import * as drainRoute from '../../src/app/api/studio/admin/queues/[name]/failed/drain/route';
import * as failedRoute from '../../src/app/api/studio/admin/queues/[name]/failed/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { QUEUES } from '../../src/lib/studio/queue/queues';
import { inlineDeadLetterQueues } from '../../src/lib/studio/services/dead-letter';
import { call, installApi, tenant } from '../helpers/api-harness';

// BACKLOG 15.D4 — dead-letter admin API (spec 11.5) against the inline queue: list with secrets
// redacted, retry, requeue (provider override only for generate-asset), typed-confirm drain, the
// staff guard and audit. The generate-asset resume path runs end to end in
// test/golden/p15-d-admin.test.ts.

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('dead-letter admin API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const staffOrg = `api-dl-staff-${randomUUID()}`;
  const org = `api-dl-org-${randomUUID()}`;
  const tokens = {
    staff: tenant(staffOrg, ['studio:admin:providers', 'studio:admin:redrive']),
    readOnly: tenant(staffOrg, ['studio:admin:providers']),
    outsider: tenant(org, ['studio:admin:providers', 'studio:admin:redrive']),
  };
  let api: ReturnType<typeof installApi>;

  const base = { organisationId: org, runId: 'run-1', planTier: 'STANDARD' as const };

  beforeEach(() => {
    api = installApi(db, tokens);
    api.deps.deadLetterQueues = () => inlineDeadLetterQueues(api.queue);
    vi.stubEnv('STUDIO_PLATFORM_ORG_IDS', staffOrg);
    api.queue.fail(
      {
        name: 'ingest-library-video',
        jobId: 'ingest-1',
        data: {
          ...base,
          item: {
            sourceUrl: 'https://cdn.example/clip.mp4?X-Amz-Signature=secret-sig',
            licenseScenario: 'OWNED',
            tags: [],
          },
        },
      },
      'download failed: Bearer abc.def.ghi rejected',
      6,
    );
    api.queue.fail(
      { name: 'scan-website', jobId: 'scan-1', data: { ...base, businessId: 'b', scanId: 's' } },
      'site unreachable',
      6,
    );
    api.queue.fail(
      {
        name: 'generate-asset',
        jobId: 'gen-1',
        data: { ...base, projectId: `missing-${randomUUID()}`, shotId: 'missing' },
      },
      'runway/timeout',
      6,
    );
  });

  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    setApiDeps(undefined);
    await db.$disconnect();
  });

  const params = (name: string, jobId?: string) => ({ name, ...(jobId && { jobId }) });

  it('lists failed jobs with secrets redacted, pages with a cursor, and audits the inspection', async () => {
    const res = await call(failedRoute.GET, {
      token: 'staff',
      params: params(QUEUES.library),
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ queue: QUEUES.library, total: 1, nextCursor: null });
    const [job] = res.json.jobs as Array<Record<string, unknown>>;
    expect(job).toMatchObject({
      id: 'ingest-1',
      name: 'ingest-library-video',
      attemptsMade: 6,
      organisationId: org,
      providerOverride: false,
    });
    expect(JSON.stringify(job)).not.toMatch(/secret-sig|abc\.def\.ghi/);
    expect(api.audits.at(-1)).toMatchObject({
      action: 'studio.dead_letter.inspect',
      resource: { type: 'queue', id: QUEUES.library },
    });

    const page = await call(failedRoute.GET, {
      token: 'staff',
      params: params(QUEUES.assets),
      path: '/api/studio/admin/queues/studio-assets/failed?limit=1',
    });
    expect((page.json.jobs as Array<{ id: string }>).map((j) => j.id)).toEqual(['gen-1']);
    expect(page.json.nextCursor).toEqual(expect.any(String));
    const next = await call(failedRoute.GET, {
      token: 'staff',
      params: params(QUEUES.assets),
      path: `/api/studio/admin/queues/studio-assets/failed?limit=1&cursor=${String(page.json.nextCursor)}`,
    });
    expect((next.json.jobs as Array<{ id: string }>).map((j) => j.id)).toEqual(['scan-1']);
  });

  it('404s an unknown queue and a job not in the failed set; 400s a bad cursor', async () => {
    expect((await call(failedRoute.GET, { token: 'staff', params: params('nope') })).status).toBe(
      404,
    );
    const missing = await call(retryRoute.POST, {
      method: 'POST',
      token: 'staff',
      params: params(QUEUES.assets, 'not-there'),
    });
    expect(missing.status).toBe(404);
    const bad = await call(failedRoute.GET, {
      token: 'staff',
      params: params(QUEUES.assets),
      path: '/api/studio/admin/queues/studio-assets/failed?cursor=bad!',
    });
    expect(bad.status).toBe(400);
  });

  it('retries a failed job onto the queue, audited', async () => {
    const res = await call(retryRoute.POST, {
      method: 'POST',
      token: 'staff',
      params: params(QUEUES.assets, 'scan-1'),
      body: { reason: 'site back up' },
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      job: { id: 'scan-1', name: 'scan-website', state: 'waiting' },
      advisory: null,
    });
    expect(api.queue.pending.map((j) => j.jobId)).toEqual(['scan-1']);
    expect(api.queue.failed.map((j) => j.id)).not.toContain('scan-1');
    expect(api.audits.at(-1)).toMatchObject({
      action: 'studio.dead_letter.retry',
      metadata: { queue: QUEUES.assets, jobName: 'scan-website', reason: 'site back up' },
    });
  });

  it('requeues a non-asset job and refuses a provider override for it (400)', async () => {
    const refused = await call(requeueRoute.POST, {
      method: 'POST',
      token: 'staff',
      params: params(QUEUES.assets, 'scan-1'),
      body: { providerId: 'luma' },
    });
    expect(refused.status).toBe(400);
    expect(String(refused.json.message)).toMatch(/generate-asset jobs only/);
    const unknown = await call(requeueRoute.POST, {
      method: 'POST',
      token: 'staff',
      params: params(QUEUES.assets, 'gen-1'),
      body: { providerId: 'not-a-provider' },
    });
    expect(unknown.status).toBe(400);

    const res = await call(requeueRoute.POST, {
      method: 'POST',
      token: 'staff',
      params: params(QUEUES.assets, 'scan-1'),
      body: {},
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ outcome: { action: 'requeued' } });
    expect(api.queue.pending.map((j) => j.jobId)).toEqual(['scan-1']);
    expect(api.audits.at(-1)).toMatchObject({ action: 'studio.dead_letter.requeue' });
  });

  it('404s a generate-asset requeue whose shot no longer exists', async () => {
    const res = await call(requeueRoute.POST, {
      method: 'POST',
      token: 'staff',
      params: params(QUEUES.assets, 'gen-1'),
      body: { providerId: 'luma' },
    });
    expect(res.status).toBe(404);
    expect(api.queue.failed.map((j) => j.id)).toContain('gen-1');
  });

  it('drains only with the queue name typed exactly, audited with the count', async () => {
    const wrong = await call(drainRoute.POST, {
      method: 'POST',
      token: 'staff',
      params: params(QUEUES.assets),
      body: { confirm: 'studio-asset', reason: 'noise' },
    });
    expect(wrong.status).toBe(400);
    const noReason = await call(drainRoute.POST, {
      method: 'POST',
      token: 'staff',
      params: params(QUEUES.assets),
      body: { confirm: QUEUES.assets },
    });
    expect(noReason.status).toBe(400);
    expect(api.queue.failed).toHaveLength(3);

    const res = await call(drainRoute.POST, {
      method: 'POST',
      token: 'staff',
      params: params(QUEUES.assets),
      body: { confirm: QUEUES.assets, reason: 'old outage noise' },
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ queue: QUEUES.assets, removed: 2 });
    expect(api.queue.failed.map((j) => j.id)).toEqual(['ingest-1']);
    expect(api.audits.at(-1)).toMatchObject({
      action: 'studio.dead_letter.drain',
      metadata: { removed: 2, reason: 'old outage noise' },
    });
  });

  it('refuses non-staff (403), read-only staff for actions (403) and anonymous callers (401)', async () => {
    const p = params(QUEUES.assets, 'scan-1');
    expect((await call(failedRoute.GET, { token: 'outsider', params: p })).status).toBe(403);
    expect((await call(failedRoute.GET, { params: p })).status).toBe(401);
    expect((await call(failedRoute.GET, { token: 'readOnly', params: p })).status).toBe(200);
    for (const route of [retryRoute.POST, requeueRoute.POST]) {
      expect((await call(route, { method: 'POST', token: 'readOnly', params: p })).status).toBe(
        403,
      );
      expect((await call(route, { method: 'POST', token: 'outsider', params: p })).status).toBe(
        403,
      );
    }
    const drain = await call(drainRoute.POST, {
      method: 'POST',
      token: 'outsider',
      params: p,
      body: { confirm: QUEUES.assets, reason: 'nope' },
    });
    expect(drain.status).toBe(403);
    expect(api.queue.failed).toHaveLength(3);
  });
});
