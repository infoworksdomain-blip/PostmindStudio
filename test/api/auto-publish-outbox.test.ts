import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as outboxRoute from '../../src/app/api/studio/projects/[id]/auto-publish/route';
import * as retryRoute from '../../src/app/api/studio/projects/[id]/auto-publish/retry/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { recordApproval } from '../../src/lib/studio/automation/approval';
import { call, installApi, tenant } from '../helpers/api-harness';

// BACKLOG 13.21 — outbox rows are written in the approval transaction; GET
// /projects/:id/auto-publish shows them; POST …/retry re-arms FAILED rows and sends them now.
// (The full approval → publish → retry journey is test/golden/admin-automation.test.ts.)

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('auto-publish outbox API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-outbox-${randomUUID()}`;
  const other = `api-outbox-other-${randomUUID()}`;
  const tokens = {
    owner: tenant(org),
    reader: tenant(org, ['studio:project:read']),
    stranger: tenant(other),
  };
  let api: ReturnType<typeof installApi>;
  let projectId = '';

  beforeAll(async () => {
    api = installApi(db, tokens);
    const project = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId: 'biz',
        createdByUserId: 'user-1',
        name: 'Auto-published launch',
        state: 'READY_FOR_REVIEW',
        sourceType: 'BRIEF',
        targetFormats: [],
        publishPolicy: 'AUTO_ON_APPROVAL',
        metadata: {
          runId: 'run-1',
          renders: {},
          autoPublish: {
            targets: [
              { platform: 'tiktok', connectionId: 'conn-missing' },
              { platform: 'youtube_short', connectionId: 'conn-yt', scheduleOffsetMinutes: 60 },
            ],
          },
        },
      },
    });
    projectId = project.id;
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.autoPublishOutbox.deleteMany({ where: { organisationId: org } });
    await db.approvalTask.deleteMany({ where: { projectId } });
    await db.videoProject.deleteMany({ where: { organisationId: org } });
    await db.notification.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  it('the approval transaction writes one PENDING row per stored target', async () => {
    const approved = await recordApproval(db, {
      projectId,
      organisationId: org,
      actorId: 'user-1',
      requiredRole: 'reviewer',
      note: null,
      now: Date.now(),
      outbox: { planTier: 'STANDARD', trigger: 'human' },
    });
    expect(approved).toBe(true);
    const rows = await db.autoPublishOutbox.findMany({
      where: { projectId },
      orderBy: { targetIndex: 'asc' },
    });
    expect(rows.map((r) => [r.targetIndex, r.state, r.trigger])).toEqual([
      [0, 'PENDING', 'human'],
      [1, 'PENDING', 'human'],
    ]);
  });

  it('GET lists the latest approval’s rows; tenant isolated', async () => {
    const res = await call(outboxRoute.GET, { token: 'reader', params: { id: projectId } });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      projectId,
      publishPolicy: 'AUTO_ON_APPROVAL',
      outbox: [
        {
          targetIndex: 0,
          target: { platform: 'tiktok', account: 'conn-missing' },
          state: 'PENDING',
        },
        {
          targetIndex: 1,
          target: { platform: 'youtube_short', scheduleOffsetMinutes: 60 },
          state: 'PENDING',
        },
      ],
    });
    expect(
      (await call(outboxRoute.GET, { token: 'stranger', params: { id: projectId } })).status,
    ).toBe(404);
  });

  it('POST retry needs studio:publication:write, re-arms FAILED rows and sends them', async () => {
    await db.autoPublishOutbox.updateMany({
      where: { projectId },
      data: { state: 'FAILED', attempts: 5, lastError: 'gave up' },
    });
    const denied = await call(retryRoute.POST, {
      method: 'POST',
      token: 'reader',
      params: { id: projectId },
      body: {},
    });
    expect(denied.status).toBe(403);

    const res = await call(retryRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: projectId },
      body: {},
    });
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ requeued: 2 });
    // No render of this run exists, so each send fails for good at once (attempts reset to 1).
    const rows = await db.autoPublishOutbox.findMany({ where: { projectId } });
    expect(rows.every((r) => r.state === 'FAILED' && r.attempts === 1)).toBe(true);
    expect(rows[0]?.lastError).toMatch(/No (tiktok|youtube_short) render/);
    expect(api.audits.find((a) => a.action === 'studio.project.auto_publish_retry')).toMatchObject({
      metadata: { requeued: 2 },
    });
    const meta = (await db.videoProject.findUniqueOrThrow({ where: { id: projectId } }))
      .metadata as { autoPublishResult?: { status: string } };
    expect(meta.autoPublishResult?.status).toBe('failed');

    // Another organisation's (or an unknown) project is not found.
    const none = await call(retryRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: 'missing-project' },
      body: {},
    });
    expect(none.status).toBe(404);
  });
});
