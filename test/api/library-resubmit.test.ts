import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ingestRoute from '../../src/app/api/studio/admin/library/ingest/route';
import * as resubmitRoute from '../../src/app/api/studio/admin/library/ingest/resubmit/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { call, installApi, tenant } from '../helpers/api-harness';

// BACKLOG 13.15 — POST /admin/library/ingest/resubmit: staff only, re-enqueues FAILED runs with
// the item stored at submission (fresh job ids), skips done/unknown/legacy runs, audits.

const hasDb = Boolean(process.env.DATABASE_URL);
const RUN = randomUUID().slice(0, 8);
const runIdOf = (url: string) => createHash('sha256').update(url).digest('hex').slice(0, 32);

describe.skipIf(!hasDb)('POST /admin/library/ingest/resubmit', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-resubmit-${randomUUID()}`;
  const tokens = {
    staff: tenant(org, ['studio:admin:library']),
    user: tenant(org, ['studio:project:read']),
  };
  let api: ReturnType<typeof installApi>;
  const urls = ['a', 'b', 'c'].map((k) => `https://corpus.example/${RUN}/${k}.mp4`);

  beforeAll(async () => {
    api = installApi(db, tokens);
    const res = await call(ingestRoute.POST, {
      method: 'POST',
      token: 'staff',
      body: {
        items: urls.slice(0, 2).map((sourceUrl) => ({
          sourceUrl,
          licenseScenario: 'NOT_REQUIRED',
          tags: ['bread'],
        })),
      },
    });
    expect(res.status).toBe(202);
    // a failed, b succeeded; c is a legacy failed run with no stored item.
    await db.videoLibraryIngestRun.update({
      where: { runId: runIdOf(urls[0] as string) },
      data: { state: 'FAILED', errorReason: 'boom', attempts: 2 },
    });
    await db.videoLibraryIngestRun.update({
      where: { runId: runIdOf(urls[1] as string) },
      data: { state: 'SUCCEEDED' },
    });
    await db.videoLibraryIngestRun.create({
      data: { runId: runIdOf(urls[2] as string), sourceUrl: urls[2] as string, state: 'FAILED' },
    });
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.videoLibraryIngestRun.deleteMany({ where: { runId: { in: urls.map(runIdOf) } } });
    await db.$disconnect();
  });

  it('stores the submitted item on the run', async () => {
    const run = await db.videoLibraryIngestRun.findUniqueOrThrow({
      where: { runId: runIdOf(urls[1] as string) },
    });
    expect(run.item).toMatchObject({ sourceUrl: urls[1], licenseScenario: 'NOT_REQUIRED' });
  });

  it('re-enqueues failed runs with a fresh job id and skips the rest', async () => {
    const before = api.queue.pending.length;
    const res = await call(resubmitRoute.POST, {
      method: 'POST',
      token: 'staff',
      body: { runIds: [...urls.map(runIdOf), 'f'.repeat(32)] },
    });
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ queued: 1, skipped: 3 });
    const runs = res.json.runs as Array<{ runId: string; action: string; reason?: string }>;
    expect(runs.find((r) => r.runId === runIdOf(urls[1] as string))?.reason).toBe(
      'already SUCCEEDED',
    );
    expect(runs.find((r) => r.runId === runIdOf(urls[2] as string))?.reason).toContain(
      'no stored item',
    );
    expect(runs.find((r) => r.runId === 'f'.repeat(32))?.reason).toBe('unknown run');
    const job = api.queue.pending.slice(before).find((j) => j.name === 'ingest-library-video');
    expect(job?.jobId).toContain('__resubmit2_');
    expect(job?.data).toMatchObject({ item: { sourceUrl: urls[0] }, batch: true });
    expect(
      (
        await db.videoLibraryIngestRun.findUniqueOrThrow({
          where: { runId: runIdOf(urls[0] as string) },
        })
      ).state,
    ).toBe('QUEUED');
    expect(api.audits.some((a) => a.action === 'studio.library.ingest_resubmit')).toBe(true);
  });

  it('is staff only and validates the body', async () => {
    expect(
      (await call(resubmitRoute.POST, { method: 'POST', token: 'user', body: {} })).status,
    ).toBe(403);
    expect(
      (await call(resubmitRoute.POST, { method: 'POST', token: 'staff', body: { runIds: ['x'] } }))
        .status,
    ).toBe(400);
    expect(
      (await call(resubmitRoute.POST, { method: 'POST', token: 'staff', body: { extra: 1 } }))
        .status,
    ).toBe(400);
  });
});
