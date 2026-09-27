import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as publicationRoute from '../../src/app/api/studio/analytics/publications/[id]/route';
import * as memoryRoute from '../../src/app/api/studio/businesses/[id]/style-memory/route';
import * as memoryItemRoute from '../../src/app/api/studio/businesses/[id]/style-memory/[memoryId]/route';
import * as hiveRoute from '../../src/app/api/studio/webhooks/hive/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import {
  hashCallbackToken,
  newCallbackToken,
} from '../../src/lib/studio/pipeline/content-safety-async';
import { call, installApi, rawCall, tenant } from '../helpers/api-harness';

// Phase 13 track A4 routes: GET /analytics/publications/:id retention + demographics (13.28),
// GET|DELETE /businesses/:id/style-memory (13.29) and POST /webhooks/hive (13.25) — auth,
// validation, tenant isolation and audit.

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('A4 routes', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-a4-${randomUUID()}`;
  const otherOrg = `api-a4-other-${randomUUID()}`;
  const tokens = {
    owner: tenant(org),
    reader: tenant(org, ['studio:project:read']),
    other: tenant(otherOrg),
  };
  let api: ReturnType<typeof installApi>;
  let publicationId = '';
  let projectId = '';

  beforeAll(async () => {
    api = installApi(db, tokens);
    const project = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId: 'biz-a4',
        createdByUserId: 'user-1',
        name: 'A4',
        state: 'PUBLISHED',
        sourceType: 'BRIEF',
        targetFormats: [{ platform: 'youtube', aspectRatio: '16:9', duration: 240 }],
      },
    });
    projectId = project.id;
    const render = await db.videoRender.create({
      data: {
        projectId,
        scriptId: 'scr',
        targetPlatform: 'youtube',
        aspectRatio: '16:9',
        resolution: '1920x1080',
        durationSec: 240,
        fps: 30,
        bitrateKbps: 4000,
        s3Bucket: 'renders',
        s3Key: 'k.mp4',
        qualityCheckState: 'PASSED',
      },
    });
    const pub = await db.videoPublication.create({
      data: {
        organisationId: org,
        projectId,
        renderId: render.id,
        platform: 'youtube',
        platformAccountId: 'chan',
        state: 'PUBLISHED',
        publishedAt: new Date('2026-09-20T08:00:00Z'),
      },
    });
    publicationId = pub.id;
    await db.videoAnalytic.createMany({
      data: [
        {
          publicationId,
          bucketAt: new Date('2026-09-21T00:00:00Z'),
          bucketSize: 'day',
          views: 50,
          retentionCurve: [{ atPct: 0.5, watchingPct: 0.4 }],
          demographics: [{ ageGroup: '25-34', gender: 'female', pct: 60 }],
        },
        {
          publicationId,
          bucketAt: new Date('2026-09-22T00:00:00Z'),
          bucketSize: 'day',
          views: 90,
          // Pre-13.28 shape: ignored in favour of the newest row that parses.
          retentionCurve: [{ sec: 1, retention: 0.9 }],
        },
        {
          publicationId,
          bucketAt: new Date('2026-09-22T05:00:00Z'),
          bucketSize: 'hour',
          views: 95,
        },
      ],
    });
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.videoAnalytic.deleteMany({ where: { publicationId } });
    await db.videoPublication.deleteMany({ where: { projectId } });
    await db.videoRender.deleteMany({ where: { projectId } });
    await db.videoProject.deleteMany({ where: { id: projectId } });
    await db.styleMemory.deleteMany({ where: { organisationId: { in: [org, otherOrg] } } });
    await db.contentSafetyTask.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  describe('GET /analytics/publications/:id (13.28)', () => {
    it('returns the newest retention curve and demographics', async () => {
      const res = await call(publicationRoute.GET, {
        token: 'reader',
        params: { id: publicationId },
      });
      expect(res.status).toBe(200);
      expect(res.json.retention).toEqual([{ atPct: 0.5, watchingPct: 0.4 }]);
      expect(res.json.demographics).toEqual([{ ageGroup: '25-34', gender: 'female', pct: 60 }]);
      expect((res.json.latest as { views: number }).views).toBe(95);
    });

    it('is tenant-scoped and authenticated', async () => {
      expect(
        (await call(publicationRoute.GET, { token: 'other', params: { id: publicationId } }))
          .status,
      ).toBe(404);
      expect((await call(publicationRoute.GET, { params: { id: publicationId } })).status).toBe(
        401,
      );
    });
  });

  describe('style memory (13.29)', () => {
    let memoryId = '';

    beforeAll(async () => {
      const row = await db.styleMemory.create({
        data: {
          organisationId: org,
          businessId: 'biz-a4',
          signalType: 'SCRIPT_STRUCTURE',
          value: { summary: 'hook in the first 1.2 s', hookWithinSec: 1.2 },
          weight: 0.7,
          evidenceCount: 4,
          reason: '3 YouTube videos kept viewers over 60%.',
          lastEvidenceAt: new Date('2026-09-20T00:00:00Z'),
        },
      });
      memoryId = row.id;
      await db.styleMemory.create({
        data: {
          organisationId: otherOrg,
          businessId: 'biz-a4',
          signalType: 'SHOT_PACE',
          value: { summary: 'other tenant' },
          reason: 'x',
        },
      });
    });

    it('lists what Studio has learned with reasons', async () => {
      const res = await call(memoryRoute.GET, { token: 'reader', params: { id: 'biz-a4' } });
      expect(res.status).toBe(200);
      expect(res.json.data).toEqual([
        expect.objectContaining({
          id: memoryId,
          signalType: 'script_structure',
          value: 'hook in the first 1.2 s',
          details: { hookWithinSec: 1.2 },
          reason: '3 YouTube videos kept viewers over 60%.',
          weight: 0.7,
          evidenceCount: 4,
        }),
      ]);
    });

    it('validates ids, needs write access and is tenant-scoped', async () => {
      expect(
        (await call(memoryRoute.GET, { token: 'reader', params: { id: 'x'.repeat(200) } })).status,
      ).toBe(400);
      expect(
        (
          await call(memoryItemRoute.DELETE, {
            method: 'DELETE',
            token: 'reader',
            params: { id: 'biz-a4', memoryId },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call(memoryItemRoute.DELETE, {
            method: 'DELETE',
            token: 'other',
            params: { id: 'biz-a4', memoryId },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await call(memoryItemRoute.DELETE, {
            method: 'DELETE',
            token: 'owner',
            params: { id: 'biz-a4', memoryId: 'bad id!' },
          })
        ).status,
      ).toBe(400);
    });

    it('deletes: wipes the inferred value, hides it, and audits', async () => {
      const res = await call(memoryItemRoute.DELETE, {
        method: 'DELETE',
        token: 'owner',
        params: { id: 'biz-a4', memoryId },
      });
      expect(res.status).toBe(200);
      expect(res.json.deleted).toBe(true);
      const row = await db.styleMemory.findUniqueOrThrow({ where: { id: memoryId } });
      expect(row.deletedAt).not.toBeNull();
      expect(row.value).toEqual({});
      expect(row.reason).toBe('Deleted by the user');
      expect(api.audits.at(-1)).toMatchObject({
        action: 'studio.style_memory.delete',
        organisationId: org,
        resource: { type: 'style_memory', id: memoryId },
        metadata: expect.objectContaining({ signalType: 'script_structure' }),
      });
      const list = await call(memoryRoute.GET, { token: 'reader', params: { id: 'biz-a4' } });
      expect(list.json.data).toEqual([]);
      const again = await call(memoryItemRoute.DELETE, {
        method: 'DELETE',
        token: 'owner',
        params: { id: 'biz-a4', memoryId },
      });
      expect(again.status).toBe(404);
    });
  });

  describe('POST /webhooks/hive (13.25)', () => {
    const token = newCallbackToken();
    let taskId = '';

    beforeAll(async () => {
      const task = await db.contentSafetyTask.create({
        data: {
          organisationId: org,
          projectId,
          runId: 'run-a4',
          renderId: `rnd-${randomUUID()}`,
          planTier: 'STANDARD',
          providerId: 'hive',
          providerTaskId: 'hive-task-1',
          callbackTokenHash: hashCallbackToken(token),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      taskId = task.id;
    });

    const post = (query: string, body: unknown) =>
      call(hiveRoute.POST, {
        method: 'POST',
        path: `/api/studio/webhooks/hive${query}`,
        body,
      });
    const hiveBody = {
      id: 'hive-task-1',
      status: [
        {
          status: { code: '0', message: 'SUCCESS' },
          response: { output: [{ time: 0, classes: [{ class: 'general_nsfw', score: 0.01 }] }] },
        },
      ],
    };

    it('refuses missing, malformed and unknown tokens with 404', async () => {
      expect((await post('', hiveBody)).status).toBe(404);
      expect((await post('?token=short', hiveBody)).status).toBe(404);
      expect((await post(`?token=${newCallbackToken()}`, hiveBody)).status).toBe(404);
    });

    it('rejects a body for another task and non-JSON bodies', async () => {
      expect((await post(`?token=${token}`, { ...hiveBody, id: 'someone-else' })).status).toBe(400);
      const res = await rawCall(hiveRoute.POST, {
        method: 'POST',
        path: `/api/studio/webhooks/hive?token=${token}`,
        body: 'not json',
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(400);
      expect((await post(`?token=${token}`, ['array'])).status).toBe(400);
    });

    it('rejects oversize bodies before reading them', async () => {
      const res = await rawCall(hiveRoute.POST, {
        method: 'POST',
        path: `/api/studio/webhooks/hive?token=${token}`,
        body: '{}',
        headers: { 'content-type': 'application/json', 'content-length': String(26 * 1024 * 1024) },
      });
      expect(res.status).toBe(413);
    });

    it('stores the result, resumes the quality gate once, and audits', async () => {
      const res = await post(`?token=${token}`, hiveBody);
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ ok: true, received: true });
      const task = await db.contentSafetyTask.findUniqueOrThrow({ where: { id: taskId } });
      expect(task.state).toBe('CALLBACK_RECEIVED');
      expect(task.result).toEqual(hiveBody);
      expect(api.queue.history.at(-1)).toMatchObject({
        name: 'run-quality-gate',
        jobId: `run-quality-gate__${projectId}__run-a4__hive_${taskId}`,
        data: { projectId, organisationId: org, runId: 'run-a4', planTier: 'STANDARD' },
      });
      expect(api.audits.at(-1)).toMatchObject({
        actorUserId: 'system:hive',
        action: 'studio.content_safety.hive_callback',
        organisationId: org,
        metadata: expect.objectContaining({ duplicate: false }),
      });
      const jobs = api.queue.history.length;
      const again = await post(`?token=${token}`, hiveBody);
      expect(again.status).toBe(200);
      expect(api.queue.history.length).toBe(jobs);
      expect(api.audits.at(-1)?.metadata).toMatchObject({ duplicate: true });
    });
  });
});
