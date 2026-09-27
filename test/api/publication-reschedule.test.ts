import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as cancelRoute from '../../src/app/api/studio/publications/[id]/cancel/route';
import * as publicationRoute from '../../src/app/api/studio/publications/[id]/route';
import * as publicationsRoute from '../../src/app/api/studio/publications/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { sealTokens } from '../../src/lib/studio/platforms/tokens';
import { drainInline } from '../../src/lib/studio/queue/workers/runtime';
import { call, installApi, tenant } from '../helpers/api-harness';
import { createHarness } from '../helpers/pipeline-harness';

// BACKLOG 13.9 — PATCH /publications/:id { scheduledFor }: auth, validation, tenant isolation,
// 409 unless SCHEDULED, audit, and the delayed job replaced (the old job can no longer post).

const hasDb = Boolean(process.env.DATABASE_URL);
const HOUR = 3_600_000;

describe.skipIf(!hasDb)('PATCH /publications/:id (reschedule)', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-resched-${randomUUID()}`;
  const tokens = {
    owner: tenant(org),
    reader: tenant(org, ['studio:project:read']),
    stranger: tenant(`api-resched-other-${randomUUID()}`),
  };
  let h: ReturnType<typeof createHarness>;
  let api: ReturnType<typeof installApi>;

  beforeEach(() => {
    h = createHarness(db);
    h.queue.defer.add('fire-scheduled-publication');
    api = installApi(db, tokens, { queue: h.queue, publishing: h.deps.publishing });
  });

  afterAll(async () => {
    setApiDeps(undefined);
    const ids = (
      await db.videoProject.findMany({ where: { organisationId: org }, select: { id: true } })
    ).map((p) => p.id);
    const pubs = await db.videoPublication.findMany({
      where: { projectId: { in: ids } },
      select: { id: true },
    });
    await db.scheduledPublication.deleteMany({
      where: { publicationId: { in: pubs.map((p) => p.id) } },
    });
    await db.videoPublication.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoRender.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.platformConnection.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  async function scheduled(at: number) {
    const project = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId: 'biz',
        createdByUserId: 'user-1',
        name: 'Reschedulable',
        state: 'APPROVED',
        sourceType: 'BRIEF',
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 15 }],
        metadata: { runId: randomUUID() },
      },
    });
    const key = `orgs/${org}/renders/${randomUUID()}.mp4`;
    await h.deps.storage.put({
      bucket: 'renders',
      key,
      body: new Uint8Array(2048),
      contentType: 'video/mp4',
    });
    const render = await db.videoRender.create({
      data: {
        projectId: project.id,
        scriptId: 'script-1',
        targetPlatform: 'tiktok',
        aspectRatio: '9:16',
        resolution: '1080x1920',
        durationSec: 15,
        fps: 30,
        bitrateKbps: 4500,
        s3Bucket: 'renders',
        s3Key: key,
        qualityCheckState: 'PASSED',
      },
    });
    const sealed = await sealTokens(h.keys, org, 'tiktok', {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + HOUR),
      scopes: ['publish'],
    });
    const conn = await db.platformConnection.create({
      data: {
        organisationId: org,
        businessId: 'biz',
        platform: 'tiktok',
        platformAccountId: `acct-${randomUUID()}`,
        platformAccountName: 'Leeds Sourdough',
        ...sealed,
        scopes: ['publish'],
        state: 'active',
        connectedByUserId: 'user-1',
      },
    });
    const res = await call(publicationsRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: {
        renderId: render.id,
        platform: 'tiktok',
        connectionId: conn.id,
        scheduledFor: new Date(at).toISOString(),
      },
    });
    expect(res.status).toBe(202);
    return (res.json.publication as { id: string }).id;
  }

  const patch = (id: string, body: unknown, token = 'owner') =>
    call(publicationRoute.PATCH, { method: 'PATCH', token, params: { id }, body });

  it('moves the publication and its schedule row, audits, and swaps the delayed job', async () => {
    const id = await scheduled(Date.now() + HOUR);
    const to = new Date(Date.now() + 5 * HOUR);
    const res = await patch(id, { scheduledFor: to.toISOString() });
    expect(res.status).toBe(200);
    const publication = res.json.publication as { state: string; scheduledFor: string };
    expect(publication.state).toBe('SCHEDULED');
    expect(new Date(publication.scheduledFor).getTime()).toBe(to.getTime());
    const row = await db.scheduledPublication.findUniqueOrThrow({ where: { publicationId: id } });
    expect(row.scheduledFor.getTime()).toBe(to.getTime());
    expect(row.jobId).toBe(`fire-scheduled__${id}__${to.getTime()}`);
    // The original job was removed from the queue; only the new one remains.
    const fires = h.queue.deferred.filter((j) => j.name === 'fire-scheduled-publication');
    expect(fires.map((j) => j.jobId)).toEqual([row.jobId]);
    const audit = api.audits.find((a) => a.action === 'studio.publication.reschedule');
    expect(audit?.resource.id).toBe(id);
    expect(audit?.metadata?.to).toBe(to.toISOString());
  });

  it('a stale fire job (old time) is a no-op; the new one publishes', async () => {
    const id = await scheduled(Date.now() + HOUR);
    // Keep a copy of the original job, as if BullMQ had not removed it yet.
    const stale = h.queue.deferred.find((j) => j.name === 'fire-scheduled-publication');
    expect(stale).toBeDefined();
    const res = await patch(id, { scheduledFor: new Date(Date.now() + 2 * HOUR).toISOString() });
    expect(res.status).toBe(200);
    h.queue.pending.push(stale as (typeof h.queue.pending)[number]);
    await drainInline(h.queue, h.deps);
    expect(h.publishers.tiktok.published).toHaveLength(0);
    expect((await db.videoPublication.findUniqueOrThrow({ where: { id } })).state).toBe(
      'SCHEDULED',
    );
    expect(h.queue.release('fire-scheduled-publication')).toBe(1);
    await drainInline(h.queue, h.deps);
    expect((await db.videoPublication.findUniqueOrThrow({ where: { id } })).state).toBe(
      'PUBLISHED',
    );
  });

  it('validates the window and the body', async () => {
    const id = await scheduled(Date.now() + HOUR);
    for (const scheduledFor of [
      new Date(Date.now() + 10_000).toISOString(),
      new Date(Date.now() + 181 * 24 * HOUR).toISOString(),
      'tomorrow',
    ]) {
      expect((await patch(id, { scheduledFor })).status).toBe(400);
    }
    expect((await patch(id, { scheduledFor: new Date().toISOString(), extra: 1 })).status).toBe(
      400,
    );
  });

  it('409 unless SCHEDULED (cancelled)', async () => {
    const id = await scheduled(Date.now() + HOUR);
    await call(cancelRoute.POST, { method: 'POST', token: 'owner', params: { id } });
    const res = await patch(id, { scheduledFor: new Date(Date.now() + 3 * HOUR).toISOString() });
    expect(res.status).toBe(409);
  });

  it('needs studio:publication:write and hides other organisations', async () => {
    const id = await scheduled(Date.now() + HOUR);
    const body = { scheduledFor: new Date(Date.now() + 3 * HOUR).toISOString() };
    expect((await patch(id, body, 'reader')).status).toBe(403);
    expect((await patch(id, body, 'stranger')).status).toBe(404);
    expect(
      (await call(publicationRoute.PATCH, { method: 'PATCH', params: { id }, body })).status,
    ).toBe(401);
  });
});
