import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as approveRoute from '../../src/app/api/studio/projects/[id]/approve/route';
import * as cancelRoute from '../../src/app/api/studio/projects/[id]/cancel/route';
import * as duplicateRoute from '../../src/app/api/studio/projects/[id]/duplicate/route';
import * as generateRoute from '../../src/app/api/studio/projects/[id]/generate/route';
import * as rejectRoute from '../../src/app/api/studio/projects/[id]/reject/route';
import * as projectRoute from '../../src/app/api/studio/projects/[id]/route';
import * as projectsRoute from '../../src/app/api/studio/projects/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { call, installApi, tenant } from '../helpers/api-harness';

// BACKLOG 4.1–4.8 + 4.10: project routes through the real wrapper (tenant → capability →
// handler) on real Postgres. Each route: happy path, 401, 403, 404/validation.

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('project API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-${randomUUID()}`;
  const otherOrg = `api-other-${randomUUID()}`;
  const tokens = {
    owner: tenant(org),
    reader: tenant(org, ['studio:project:read']),
    editor: tenant(org, ['studio:project:read', 'studio:project:write']),
    stranger: tenant(otherOrg),
    nomember: 'forbidden' as const,
  };
  let api: ReturnType<typeof installApi>;

  const createBody = {
    name: 'Sourdough launch',
    businessId: 'biz-1',
    brief: { rawInput: 'Launch our sourdough subscription', callToAction: 'Subscribe' },
    targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 30 }],
    costBudgetPence: 500,
  };

  async function create(token = 'owner') {
    const res = await call(projectsRoute.POST, { method: 'POST', token, body: createBody });
    return (res.json.project as { id: string }).id;
  }

  beforeAll(() => {
    api = installApi(db, tokens);
  });
  beforeEach(() => {
    api = installApi(db, tokens);
  });
  afterAll(async () => {
    setApiDeps(undefined);
    const ids = (
      await db.videoProject.findMany({
        where: { organisationId: { in: [org, otherOrg] } },
        select: { id: true },
      })
    ).map((p) => p.id);
    await db.approvalTask.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  describe('POST /projects', () => {
    it('creates a DRAFT project scoped to the caller and audits it', async () => {
      const res = await call(projectsRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: createBody,
      });
      expect(res.status).toBe(201);
      expect(res.json).toMatchObject({
        ok: true,
        project: {
          organisationId: org,
          createdByUserId: 'user-1',
          state: 'DRAFT',
          description: 'Launch our sourdough subscription',
          targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 30 }],
          costBudgetPence: 500,
        },
      });
      expect(res.headers.get('x-correlation-id')).toBeTruthy();
      expect(api.audits.at(-1)).toMatchObject({
        action: 'studio.project.create',
        organisationId: org,
        actorUserId: 'user-1',
      });
    });

    it('17.9: stores no name when none is given (never the English placeholder)', async () => {
      const { name: _name, ...unnamed } = createBody;
      void _name;
      const res = await call(projectsRoute.POST, { method: 'POST', token: 'owner', body: unnamed });
      expect(res.status).toBe(201);
      expect(res.json.project).toMatchObject({ name: null });
      // The legacy placeholder an older client sends is not stored either.
      const legacy = await call(projectsRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: { ...createBody, name: 'Untitled video' },
      });
      expect(legacy.json.project).toMatchObject({ name: null });
      const id = (legacy.json.project as { id: string }).id;
      // A copy of an unnamed project stays unnamed (no "(copy)" English suffix on nothing).
      const copy = await call(duplicateRoute.POST, {
        method: 'POST',
        token: 'owner',
        params: { id },
      });
      expect(copy.json.project).toMatchObject({ name: null });
      // Clearing a name with PATCH is allowed; the row then reads as untitled.
      const named = await create();
      const cleared = await call(projectRoute.PATCH, {
        method: 'PATCH',
        token: 'owner',
        params: { id: named },
        body: { name: null },
      });
      expect(cleared.status).toBe(200);
      expect((await db.videoProject.findUniqueOrThrow({ where: { id: named } })).name).toBeNull();
    });

    it('returns 401 without a token and 403 without membership or capability', async () => {
      expect((await call(projectsRoute.POST, { method: 'POST', body: createBody })).status).toBe(
        401,
      );
      expect(
        (await call(projectsRoute.POST, { method: 'POST', token: 'nomember', body: createBody }))
          .status,
      ).toBe(403);
      const denied = await call(projectsRoute.POST, {
        method: 'POST',
        token: 'reader',
        body: createBody,
      });
      expect(denied.status).toBe(403);
      expect(denied.json).toMatchObject({
        ok: false,
        error: 'forbidden',
        details: { capability: 'studio:project:write' },
      });
    });

    it.each([
      ['empty name', { ...createBody, name: '' }],
      [
        'unknown platform',
        {
          ...createBody,
          targetFormats: [{ platform: 'myspace', aspectRatio: '9:16', durationSec: 30 }],
        },
      ],
      [
        'too short',
        {
          ...createBody,
          targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 1 }],
        },
      ],
      ['no formats', { ...createBody, targetFormats: [] }],
      ['negative budget', { ...createBody, costBudgetPence: -1 }],
      ['foreign brand kit', { ...createBody, brandKitId: 'nope' }],
    ])('rejects %s with 400', async (_label, body) => {
      const res = await call(projectsRoute.POST, { method: 'POST', token: 'owner', body });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('validation_error');
    });

    it('rejects malformed JSON with 400', async () => {
      const res = await call(projectsRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: '{not json',
      });
      expect(res.status).toBe(400);
    });

    it('replays the first response for a repeated Idempotency-Key', async () => {
      const headers = { 'idempotency-key': `key-${randomUUID()}` };
      const first = await call(projectsRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: createBody,
        headers,
      });
      const second = await call(projectsRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: createBody,
        headers,
      });
      expect(second.headers.get('idempotent-replayed')).toBe('true');
      expect(second.json).toEqual(first.json);
      const mismatch = await call(projectsRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: { ...createBody, name: 'Different' },
        headers,
      });
      expect(mismatch.status).toBe(422);
      expect(mismatch.json.error).toBe('idempotency_key_mismatch');
      const bad = await call(projectsRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: createBody,
        headers: { 'idempotency-key': 'x' },
      });
      expect(bad.status).toBe(400);
    });
  });

  it('never executes twice for concurrent requests with the same Idempotency-Key', async () => {
    const headers = { 'idempotency-key': `race-${randomUUID()}` };
    const before = await db.videoProject.count({ where: { organisationId: org } });
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        call(projectsRoute.POST, { method: 'POST', token: 'owner', body: createBody, headers }),
      ),
    );
    const created = results.filter(
      (r) => r.status === 201 && r.headers.get('idempotent-replayed') !== 'true',
    );
    expect(created).toHaveLength(1);
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect(await db.videoProject.count({ where: { organisationId: org } })).toBe(before + 1);
  });

  it('releases the key when the request fails so it can be retried', async () => {
    const headers = { 'idempotency-key': `retry-${randomUUID()}` };
    const bad = { ...createBody, brandKitId: 'missing' };
    expect(
      (await call(projectsRoute.POST, { method: 'POST', token: 'owner', body: bad, headers }))
        .status,
    ).toBe(400);
    expect(
      (await call(projectsRoute.POST, { method: 'POST', token: 'owner', body: bad, headers }))
        .status,
    ).toBe(400);
  });

  describe('GET /projects and /projects/:id', () => {
    it('lists only the caller organisation, newest first, with cursor pagination', async () => {
      await create();
      await create();
      await create('stranger');
      const page1 = await call(projectsRoute.GET, {
        token: 'reader',
        path: '/api/studio/projects?limit=1',
      });
      expect(page1.status).toBe(200);
      const data = page1.json.data as Array<{ organisationId: string; id: string }>;
      expect(data).toHaveLength(1);
      expect(page1.json.hasMore).toBe(true);
      const page2 = await call(projectsRoute.GET, {
        token: 'reader',
        path: `/api/studio/projects?limit=100&cursor=${page1.json.nextCursor as string}`,
      });
      const all = [...data, ...(page2.json.data as typeof data)];
      expect(all.every((p) => p.organisationId === org)).toBe(true);
      expect(new Set(all.map((p) => p.id)).size).toBe(all.length);
    });

    it('filters by state and rejects bad query params', async () => {
      const res = await call(projectsRoute.GET, {
        token: 'reader',
        path: '/api/studio/projects?state=DRAFT&days=30',
      });
      expect((res.json.data as Array<{ state: string }>).every((p) => p.state === 'DRAFT')).toBe(
        true,
      );
      expect(
        (
          await call(projectsRoute.GET, {
            token: 'reader',
            path: '/api/studio/projects?limit=1000',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await call(projectsRoute.GET, {
            token: 'reader',
            path: '/api/studio/projects?state=NOPE',
          })
        ).status,
      ).toBe(400);
    });

    it("reads one project; another organisation's project is 404", async () => {
      const id = await create();
      const res = await call(projectRoute.GET, { token: 'reader', params: { id } });
      expect(res.status).toBe(200);
      expect(res.json.project).toMatchObject({ id, scripts: [], renders: [], publications: [] });
      expect((await call(projectRoute.GET, { token: 'stranger', params: { id } })).status).toBe(
        404,
      );
      expect(
        (await call(projectRoute.GET, { token: 'reader', params: { id: 'missing' } })).status,
      ).toBe(404);
      expect((await call(projectRoute.GET, { params: { id } })).status).toBe(401);
    });
  });

  describe('PATCH / DELETE /projects/:id', () => {
    it('updates editable fields', async () => {
      const id = await create();
      const res = await call(projectRoute.PATCH, {
        method: 'PATCH',
        token: 'owner',
        params: { id },
        body: {
          name: 'Renamed',
          brief: { targetAudience: 'Leeds commuters' },
          costBudgetPence: 900,
        },
      });
      expect(res.status).toBe(200);
      expect(res.json.project).toMatchObject({
        name: 'Renamed',
        costBudgetPence: 900,
        metadata: { briefHints: { targetAudience: 'Leeds commuters' } },
      });
      expect(
        (
          await call(projectRoute.PATCH, {
            method: 'PATCH',
            token: 'owner',
            params: { id },
            body: {},
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await call(projectRoute.PATCH, {
            method: 'PATCH',
            token: 'reader',
            params: { id },
            body: { name: 'x' },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call(projectRoute.PATCH, {
            method: 'PATCH',
            token: 'stranger',
            params: { id },
            body: { name: 'x' },
          })
        ).status,
      ).toBe(404);
    });

    it('20.3: scheduledStartAt may be at most 180 days ahead, on create and update', async () => {
      const DAY = 86_400_000;
      const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();
      const tooFar = await call(projectsRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: { ...createBody, publishPolicy: 'SCHEDULED', scheduledStartAt: at(181) },
      });
      expect(tooFar.status).toBe(400);
      expect(tooFar.json.message).toContain('180 days');
      const fine = await call(projectsRoute.POST, {
        method: 'POST',
        token: 'owner',
        // 20.12: SCHEDULED needs an account to post to, so the date alone is stored here.
        body: { ...createBody, scheduledStartAt: at(179) },
      });
      expect(fine.status).toBe(201);
      const id = (fine.json.project as { id: string }).id;
      const patch = (scheduledStartAt: string | null) =>
        call(projectRoute.PATCH, {
          method: 'PATCH',
          token: 'owner',
          params: { id },
          body: { scheduledStartAt },
        });
      expect((await patch(at(200))).status).toBe(400);
      expect((await patch(at(30))).status).toBe(200);
      expect((await patch(null)).status).toBe(200);
    });

    it('refuses edits while generating (409) and archives when idle', async () => {
      const id = await create();
      await call(generateRoute.POST, { method: 'POST', token: 'owner', params: { id } });
      const conflict = await call(projectRoute.PATCH, {
        method: 'PATCH',
        token: 'owner',
        params: { id },
        body: { name: 'x' },
      });
      expect(conflict.status).toBe(409);
      expect(
        (await call(projectRoute.DELETE, { method: 'DELETE', token: 'owner', params: { id } }))
          .status,
      ).toBe(409);

      const idle = await create();
      expect(
        (
          await call(projectRoute.DELETE, {
            method: 'DELETE',
            token: 'owner',
            params: { id: idle },
          })
        ).status,
      ).toBe(200);
      expect((await call(projectRoute.GET, { token: 'owner', params: { id: idle } })).status).toBe(
        404,
      );
    });
  });

  describe('generate / cancel', () => {
    it('queues plan-project with a new run and the tenant plan tier', async () => {
      const id = await create();
      const res = await call(generateRoute.POST, {
        method: 'POST',
        token: 'owner',
        params: { id },
      });
      expect(res.status).toBe(202);
      expect(res.json).toMatchObject({ projectId: id, state: 'QUEUED', planTier: 'STANDARD' });
      const job = api.queue.history.at(-1);
      expect(job).toMatchObject({
        name: 'plan-project',
        data: { projectId: id, organisationId: org, runId: res.json.runId, planTier: 'STANDARD' },
      });
      const project = await db.videoProject.findUniqueOrThrow({ where: { id } });
      expect(project.state).toBe('QUEUED');
      expect((project.metadata as { runId: string }).runId).toBe(res.json.runId);
      // A second generate while queued is a conflict.
      expect(
        (await call(generateRoute.POST, { method: 'POST', token: 'owner', params: { id } })).status,
      ).toBe(409);
      expect(
        (await call(generateRoute.POST, { method: 'POST', token: 'reader', params: { id } }))
          .status,
      ).toBe(403);
      expect(
        (await call(generateRoute.POST, { method: 'POST', token: 'stranger', params: { id } }))
          .status,
      ).toBe(404);
    });

    it('QA: a queue outage answers 502 and puts the project back to DRAFT (not stuck QUEUED)', async () => {
      const id = await create();
      const add = api.queue.add.bind(api.queue);
      api.queue.add = async () => Promise.reject(new Error('redis unavailable'));
      const res = await call(generateRoute.POST, {
        method: 'POST',
        token: 'owner',
        params: { id },
      });
      api.queue.add = add;
      expect(res.status).toBe(502);
      expect((await db.videoProject.findUniqueOrThrow({ where: { id } })).state).toBe('DRAFT');
      const retry = await call(generateRoute.POST, {
        method: 'POST',
        token: 'owner',
        params: { id },
      });
      expect(retry.status).toBe(202);
    });

    it('cancels an in-flight run, supersedes its runId and cancels running provider jobs', async () => {
      const id = await create();
      const started = await call(generateRoute.POST, {
        method: 'POST',
        token: 'owner',
        params: { id },
      });
      const job = await db.providerJob.create({
        data: {
          organisationId: org,
          projectId: id,
          provider: 'runway',
          providerJobId: 'task-1',
          operation: 'text_to_video',
          requestBody: {},
          state: 'RUNNING',
          costPence: 45,
        },
      });
      const res = await call(cancelRoute.POST, { method: 'POST', token: 'owner', params: { id } });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ state: 'FAILED', providerJobsCancelled: 1 });
      const project = await db.videoProject.findUniqueOrThrow({ where: { id } });
      expect(project).toMatchObject({ state: 'FAILED', errorReason: 'cancelled_by_user' });
      expect((project.metadata as { runId: string }).runId).not.toBe(started.json.runId);
      expect((await db.providerJob.findUniqueOrThrow({ where: { id: job.id } })).state).toBe(
        'CANCELLED',
      );
      expect(
        (await call(cancelRoute.POST, { method: 'POST', token: 'owner', params: { id } })).status,
      ).toBe(409);
      await db.providerJob.deleteMany({ where: { projectId: id } });
      await db.providerUsage.deleteMany({ where: { organisationId: org } });
    });
  });

  describe('approve / reject / duplicate', () => {
    async function readyProject() {
      const id = await create();
      await db.videoProject.update({ where: { id }, data: { state: 'READY_FOR_REVIEW' } });
      return id;
    }

    it('approves a reviewable project and records the approval', async () => {
      const id = await readyProject();
      const res = await call(approveRoute.POST, {
        method: 'POST',
        token: 'owner',
        params: { id },
        body: { note: 'looks good' },
      });
      expect(res.status).toBe(200);
      expect(res.json.project).toMatchObject({ state: 'APPROVED' });
      expect(await db.approvalTask.findFirst({ where: { projectId: id } })).toMatchObject({
        state: 'APPROVED',
        resolvedByUserId: 'user-1',
        note: 'looks good',
      });
      expect(
        (await call(approveRoute.POST, { method: 'POST', token: 'owner', params: { id } })).status,
      ).toBe(409);
      expect(
        (await call(approveRoute.POST, { method: 'POST', token: 'reader', params: { id } })).status,
      ).toBe(403);
      // Editors without studio:project:approve cannot self-approve.
      expect(
        (await call(approveRoute.POST, { method: 'POST', token: 'editor', params: { id } })).status,
      ).toBe(403);
    });

    it('requires a note to reject', async () => {
      const id = await readyProject();
      expect(
        (await call(rejectRoute.POST, { method: 'POST', token: 'owner', params: { id }, body: {} }))
          .status,
      ).toBe(400);
      const res = await call(rejectRoute.POST, {
        method: 'POST',
        token: 'owner',
        params: { id },
        body: { note: 'wrong tone' },
      });
      expect(res.status).toBe(200);
      expect(res.json.project).toMatchObject({
        state: 'REJECTED',
        errorReason: 'rejected: wrong tone',
      });
      expect(
        (
          await call(rejectRoute.POST, {
            method: 'POST',
            token: 'stranger',
            params: { id },
            body: { note: 'x' },
          })
        ).status,
      ).toBe(404);
    });

    it('duplicates into a new DRAFT', async () => {
      const id = await create();
      const res = await call(duplicateRoute.POST, {
        method: 'POST',
        token: 'owner',
        params: { id },
      });
      expect(res.status).toBe(201);
      expect(res.json.project).toMatchObject({
        state: 'DRAFT',
        name: 'Sourdough launch (copy)',
        metadata: { duplicatedFrom: id },
      });
      expect(
        (await call(duplicateRoute.POST, { method: 'POST', token: 'stranger', params: { id } }))
          .status,
      ).toBe(404);
    });
  });
});
