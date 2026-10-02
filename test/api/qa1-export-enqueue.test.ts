import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as exportRoute from '../../src/app/api/studio/account/export/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { call, installApi, tenant } from '../helpers/api-harness';

// QA 1: when the queue refuses the export job (Redis down), the request must not leave a QUEUED
// row holding the organisation's one-at-a-time slot (activeKey) forever.

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('account export when the queue is unavailable', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `qa1-export-${randomUUID()}`;
  let api: ReturnType<typeof installApi>;

  beforeEach(() => {
    api = installApi(db, { owner: tenant(org) });
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.dataExport.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  it('fails the request, frees the slot and lets the next request through', async () => {
    const add = api.deps.queue.add.bind(api.deps.queue);
    api.deps.queue.add = async () => {
      throw new Error('queue unavailable');
    };
    const failed = await call(exportRoute.POST, { method: 'POST', body: {}, token: 'owner' });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    const rows = await db.dataExport.findMany({ where: { organisationId: org } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'FAILED', activeKey: null });
    expect(rows[0]?.errorReason).toBeTruthy();

    api.deps.queue.add = add;
    const retry = await call(exportRoute.POST, { method: 'POST', body: {}, token: 'owner' });
    expect(retry.status).toBe(202);
  });

  it('lists an export whose link has run out as EXPIRED, not READY with a dead Download', async () => {
    const past = new Date(Date.now() - 86_400_000);
    await db.dataExport.create({
      data: {
        organisationId: org,
        requestedByUserId: 'user-1',
        include: ['brand'],
        state: 'READY',
        s3Bucket: 'b',
        s3Key: 'k',
        expiresAt: past,
      },
    });
    const live = await db.dataExport.create({
      data: {
        organisationId: org,
        requestedByUserId: 'user-1',
        include: ['brand'],
        state: 'READY',
        s3Bucket: 'b',
        s3Key: 'k2',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const res = await call(exportRoute.GET, { token: 'owner' });
    const rows = res.json.data as Array<{ id: string; state: string; expiresAt: string | null }>;
    expect(rows.find((r) => r.id === live.id)?.state).toBe('READY');
    const expired = rows.filter((r) => r.expiresAt && Date.parse(r.expiresAt) < Date.now());
    expect(expired.length).toBeGreaterThan(0);
    for (const row of expired) expect(row.state).toBe('EXPIRED');
  });
});
