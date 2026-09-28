import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as workflowRoute from '../../src/app/api/studio/approval-workflows/[id]/route';
import * as workflowsRoute from '../../src/app/api/studio/approval-workflows/route';
import * as approvalRoute from '../../src/app/api/studio/projects/[id]/approval/route';
import * as approveRoute from '../../src/app/api/studio/projects/[id]/approve/route';
import * as rejectRoute from '../../src/app/api/studio/projects/[id]/reject/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import type { TenantContext } from '../../src/lib/tenant';
import { ALL_CAPABILITIES, call, installApi, tenant } from '../helpers/api-harness';

// 15.D3 — approval workflow CRUD and the step machine behind POST /projects/:id/approve, through
// the real routes on real Postgres: auth, validation, tenant isolation, audit, step roles,
// minApprovers, "same person twice", reject at step 2, mid-review edits, and the unchanged
// single-step path when no workflow applies.

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('approval workflows API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-awf-${randomUUID()}`;
  const otherOrg = `api-awf-other-${randomUUID()}`;
  const member = (userId: string, role: string, caps = ALL_CAPABILITIES): TenantContext => ({
    ...tenant(org, caps, userId),
    memberships: [{ organisationId: org, role }],
  });
  const tokens = {
    owner: tenant(org),
    admin: member('admin-1', 'admin'),
    reviewerA: member('client-a', 'client_reviewer'),
    reviewerB: member('client-b', 'client_reviewer'),
    reader: tenant(org, ['studio:project:read']),
    stranger: tenant(otherOrg),
    nomember: 'forbidden' as const,
  };
  let api: ReturnType<typeof installApi>;

  beforeEach(async () => {
    api = installApi(db, tokens);
    await db.approvalWorkflow.deleteMany({ where: { organisationId: { in: [org, otherOrg] } } });
  });

  afterAll(async () => {
    setApiDeps(undefined);
    const ids = (
      await db.videoProject.findMany({
        where: { organisationId: { in: [org, otherOrg] } },
        select: { id: true },
      })
    ).map((p) => p.id);
    await db.autoPublishOutbox.deleteMany({ where: { projectId: { in: ids } } });
    await db.approvalTask.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.approvalWorkflow.deleteMany({ where: { organisationId: { in: [org, otherOrg] } } });
    await db.$disconnect();
  });

  const TWO_STEP = {
    name: 'Client sign-off',
    steps: [
      { role: 'admin', minApprovers: 1 },
      { role: 'client_reviewer', minApprovers: 2 },
    ],
    appliesTo: { businessIds: ['biz-client'] },
  };

  /** Audit metadata without the per-request correlationId. */
  const meta = (m: Record<string, unknown> | undefined) =>
    Object.fromEntries(Object.entries(m ?? {}).filter(([k]) => k !== 'correlationId'));
  const create = (body: unknown, token = 'owner') =>
    call(workflowsRoute.POST, { method: 'POST', token, body });
  const approve = (id: string, token: string, note?: string) =>
    call(approveRoute.POST, {
      method: 'POST',
      token,
      params: { id },
      body: note ? { note } : {},
    });
  const status = (id: string, token = 'reader') =>
    call(approvalRoute.GET, { token, params: { id } });

  async function readyProject(businessId = 'biz-client', metadata: object = { runId: 'run-1' }) {
    const project = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId,
        createdByUserId: 'creator-1',
        name: 'Client launch',
        state: 'READY_FOR_REVIEW',
        sourceType: 'BRIEF',
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 15 }],
        metadata,
      },
    });
    return project.id;
  }

  async function createTwoStep() {
    const res = await create(TWO_STEP);
    expect(res.status).toBe(201);
    return res.json.workflow as { id: string };
  }

  describe('CRUD', () => {
    it('creates, reads, lists, updates and deletes a workflow, auditing each change', async () => {
      const res = await create(TWO_STEP);
      expect(res.status).toBe(201);
      const workflow = res.json.workflow as Record<string, unknown>;
      expect(workflow).toMatchObject({
        organisationId: org,
        name: 'Client sign-off',
        steps: TWO_STEP.steps,
        appliesTo: { businessIds: ['biz-client'], platforms: [], tags: [] },
      });
      const id = workflow.id as string;

      const got = await call(workflowRoute.GET, { token: 'reader', params: { id } });
      expect(got.status).toBe(200);
      expect((got.json.workflow as { id: string }).id).toBe(id);

      const listed = await call(workflowsRoute.GET, {
        token: 'reader',
        path: '/api/studio/approval-workflows?businessId=biz-client&platforms=tiktok',
      });
      expect(listed.status).toBe(200);
      expect((listed.json.data as Array<{ id: string }>).map((w) => w.id)).toEqual([id]);
      expect(listed.json.matched).toBe(id);
      const other = await call(workflowsRoute.GET, {
        token: 'reader',
        path: '/api/studio/approval-workflows?businessId=biz-else',
      });
      expect(other.json.matched).toBeNull();

      const patched = await call(workflowRoute.PATCH, {
        method: 'PATCH',
        token: 'owner',
        params: { id },
        body: { name: 'Client + legal', steps: [{ role: 'Legal', minApprovers: 1 }] },
      });
      expect(patched.status).toBe(200);
      expect(patched.json.workflow).toMatchObject({
        name: 'Client + legal',
        steps: [{ role: 'legal', minApprovers: 1 }],
        appliesTo: { businessIds: ['biz-client'] },
      });

      const deleted = await call(workflowRoute.DELETE, {
        method: 'DELETE',
        token: 'owner',
        params: { id },
      });
      expect(deleted.status).toBe(200);
      expect((await call(workflowRoute.GET, { token: 'owner', params: { id } })).status).toBe(404);

      expect(api.audits.map((a) => [a.action, a.resource?.id, a.organisationId])).toEqual([
        ['studio.approval_workflow.create', id, org],
        ['studio.approval_workflow.update', id, org],
        ['studio.approval_workflow.delete', id, org],
      ]);
    });

    it('validates the body (400)', async () => {
      for (const body of [
        { ...TWO_STEP, steps: [] },
        { ...TWO_STEP, steps: [{ role: 'admin', minApprovers: 0 }] },
        { ...TWO_STEP, steps: [{ role: 'admin' }] },
        { ...TWO_STEP, appliesTo: { platforms: ['myspace'] } },
        { ...TWO_STEP, name: '' },
        { ...TWO_STEP, extra: true },
      ]) {
        expect((await create(body)).status).toBe(400);
      }
      const { id } = await createTwoStep();
      expect(
        (
          await call(workflowRoute.PATCH, {
            method: 'PATCH',
            token: 'owner',
            params: { id },
            body: {},
          })
        ).status,
      ).toBe(400);
    });

    it('enforces auth, capability and the owner/admin role for changes', async () => {
      expect((await call(workflowsRoute.GET, {})).status).toBe(401);
      expect((await call(workflowsRoute.GET, { token: 'nomember' })).status).toBe(403);
      // Readers see workflows (create-screen picker) but cannot change them.
      expect((await call(workflowsRoute.GET, { token: 'reader' })).status).toBe(200);
      expect((await create(TWO_STEP, 'reader')).status).toBe(403);
      // A client reviewer holds studio:project:approve but may not loosen the process.
      const refused = await create(TWO_STEP, 'reviewerA');
      expect(refused.status).toBe(403);
      expect(refused.json.message).toContain('owner or admin');
      expect((await create(TWO_STEP, 'admin')).status).toBe(201);
    });

    it('isolates organisations', async () => {
      const { id } = await createTwoStep();
      expect((await call(workflowRoute.GET, { token: 'stranger', params: { id } })).status).toBe(
        404,
      );
      expect(
        (
          await call(workflowRoute.PATCH, {
            method: 'PATCH',
            token: 'stranger',
            params: { id },
            body: { name: 'mine now' },
          })
        ).status,
      ).toBe(404);
      expect(
        (await call(workflowRoute.DELETE, { method: 'DELETE', token: 'stranger', params: { id } }))
          .status,
      ).toBe(404);
      const list = await call(workflowsRoute.GET, { token: 'stranger' });
      expect(list.json.data).toEqual([]);
      expect(await db.approvalWorkflow.count({ where: { id } })).toBe(1);
    });
  });

  describe('step machine', () => {
    it('walks two steps (minApprovers 2), refusing wrong roles and double approvals', async () => {
      const workflow = await createTwoStep();
      const id = await readyProject();
      api.audits.length = 0;

      const before = await status(id);
      expect(before.json.approval).toMatchObject({
        workflow: { id: workflow.id, name: 'Client sign-off' },
        started: false,
        stepIndex: 0,
        stepCount: 2,
        waitingFor: { role: 'admin', minApprovers: 1, approvals: 0 },
      });

      // Step 1 needs an admin: a client reviewer is refused.
      const early = await approve(id, 'reviewerA');
      expect(early.status).toBe(403);
      expect(early.json.details).toMatchObject({ requiredRole: 'admin', stepIndex: 0 });

      const first = await approve(id, 'admin', 'brand ok');
      expect(first.status).toBe(200);
      expect(first.json.approval).toMatchObject({
        workflowId: workflow.id,
        stepIndex: 0,
        remainingSteps: 1,
        stepCount: 2,
        nextStepIndex: 1,
        waitingFor: { role: 'client_reviewer', minApprovers: 2, approvals: 0 },
      });
      expect(first.json.project).toMatchObject({ state: 'READY_FOR_REVIEW' });
      expect(first.json.autoPublish).toMatchObject({ status: 'skipped' });
      expect(first.json.scheduled).toEqual([]);

      const second = await approve(id, 'reviewerA');
      expect(second.status).toBe(200);
      expect(second.json.approval).toMatchObject({
        stepIndex: 1,
        remainingSteps: 1,
        waitingFor: { role: 'client_reviewer', approvals: 1 },
      });
      expect(second.json.project).toMatchObject({ state: 'READY_FOR_REVIEW' });

      const twice = await approve(id, 'reviewerA');
      expect(twice.status).toBe(409);
      expect(twice.json.message).toContain('already approved');

      const mid = await status(id);
      expect(mid.json.approval).toMatchObject({
        started: true,
        outcome: 'pending',
        stepIndex: 1,
        waitingFor: { role: 'client_reviewer', approvals: 1 },
      });

      const last = await approve(id, 'reviewerB');
      expect(last.status).toBe(200);
      expect(last.json.approval).toMatchObject({
        stepIndex: 1,
        remainingSteps: 0,
        nextStepIndex: null,
        waitingFor: null,
      });
      expect(last.json.project).toMatchObject({ state: 'APPROVED' });
      expect(last.json.autoPublish).toMatchObject({ status: 'skipped' });

      const tasks = await db.approvalTask.findMany({
        where: { projectId: id },
        orderBy: { resolvedAt: 'asc' },
      });
      expect(
        tasks.map((t) => [t.stepIndex, t.requiredRole, t.resolvedByUserId, t.workflowId]),
      ).toEqual([
        [0, 'admin', 'admin-1', workflow.id],
        [1, 'client_reviewer', 'client-a', workflow.id],
        [1, 'client_reviewer', 'client-b', workflow.id],
      ]);
      expect(tasks.every((t) => t.state === 'APPROVED' && t.resolvedAt)).toBe(true);
      expect(tasks[0]?.note).toBe('brand ok');

      expect(api.audits.map((a) => [a.action, a.actorUserId, meta(a.metadata)])).toEqual([
        [
          'studio.project.approval_step',
          'admin-1',
          { workflowId: workflow.id, stepIndex: 0, remainingSteps: 1 },
        ],
        [
          'studio.project.approval_step',
          'client-a',
          { workflowId: workflow.id, stepIndex: 1, remainingSteps: 1 },
        ],
        [
          'studio.project.approve',
          'client-b',
          { workflowId: workflow.id, stepIndex: 1, remainingSteps: 0 },
        ],
      ]);
      expect((await status(id)).json.approval).toMatchObject({ outcome: 'approved' });
      expect((await approve(id, 'admin')).status).toBe(409);
    });

    it('rejects at step 2: project REJECTED, task carries workflowId and stepIndex', async () => {
      const workflow = await createTwoStep();
      const id = await readyProject();
      expect((await approve(id, 'admin')).status).toBe(200);
      const res = await call(rejectRoute.POST, {
        method: 'POST',
        token: 'reviewerA',
        params: { id },
        body: { note: 'wrong logo' },
      });
      expect(res.status).toBe(200);
      expect(res.json.project).toMatchObject({
        state: 'REJECTED',
        errorReason: 'rejected: wrong logo',
      });
      const rejected = await db.approvalTask.findFirst({
        where: { projectId: id, state: 'REJECTED' },
      });
      expect(rejected).toMatchObject({
        workflowId: workflow.id,
        stepIndex: 1,
        requiredRole: 'client_reviewer',
        resolvedByUserId: 'client-a',
        note: 'wrong logo',
      });
      expect(rejected?.resolvedAt).toBeInstanceOf(Date);
      expect((await status(id)).json.approval).toMatchObject({ outcome: 'rejected' });
    });

    it('keeps the steps a review round started with when the workflow is edited or deleted', async () => {
      const workflow = await createTwoStep();
      const id = await readyProject();
      expect((await approve(id, 'admin')).status).toBe(200);
      await call(workflowRoute.PATCH, {
        method: 'PATCH',
        token: 'owner',
        params: { id: workflow.id },
        body: { steps: [{ role: 'legal', minApprovers: 1 }] },
      });
      // Still the frozen 2-step round: client reviewers, not legal.
      expect((await approve(id, 'reviewerA')).json.approval).toMatchObject({ stepIndex: 1 });
      await call(workflowRoute.DELETE, {
        method: 'DELETE',
        token: 'owner',
        params: { id: workflow.id },
      });
      const done = await approve(id, 'reviewerB');
      expect(done.status).toBe(200);
      expect(done.json.project).toMatchObject({ state: 'APPROVED' });
    });

    it('starts a new round when the project is regenerated (new runId)', async () => {
      await createTwoStep();
      const id = await readyProject();
      expect((await approve(id, 'admin')).status).toBe(200);
      const project = await db.videoProject.findUniqueOrThrow({ where: { id } });
      await db.videoProject.update({
        where: { id },
        data: { metadata: { ...(project.metadata as object), runId: 'run-2' } },
      });
      // The admin's earlier approval belonged to run-1: step 1 again.
      expect((await approve(id, 'reviewerA')).status).toBe(403);
      expect((await approve(id, 'admin')).json.approval).toMatchObject({ stepIndex: 0 });
    });

    it('uses an explicitly chosen workflow (metadata.approvalWorkflowId) over appliesTo', async () => {
      await createTwoStep();
      const solo = (
        await create({ name: 'Legal only', steps: [{ role: 'legal', minApprovers: 1 }] })
      ).json.workflow as { id: string };
      const id = await readyProject('biz-client', { runId: 'r', approvalWorkflowId: solo.id });
      expect((await status(id)).json.approval).toMatchObject({
        workflow: { id: solo.id },
        waitingFor: { role: 'legal' },
      });
      expect((await approve(id, 'admin')).status).toBe(403);
    });

    it('leaves projects without a matching workflow on single-step approval', async () => {
      await createTwoStep();
      const id = await readyProject('biz-other');
      expect((await status(id)).json.approval).toMatchObject({ workflow: null });
      api.audits.length = 0;
      const res = await approve(id, 'reviewerA', 'fine');
      expect(res.status).toBe(200);
      expect(res.json.project).toMatchObject({ state: 'APPROVED' });
      expect(res.json.approval).toEqual({
        workflowId: null,
        workflowName: null,
        stepIndex: 0,
        stepCount: 1,
        remainingSteps: 0,
        nextStepIndex: null,
        waitingFor: null,
      });
      expect(await db.approvalTask.findFirst({ where: { projectId: id } })).toMatchObject({
        workflowId: null,
        stepIndex: 0,
        requiredRole: 'reviewer',
        resolvedByUserId: 'client-a',
      });
      expect(api.audits.map((a) => [a.action, meta(a.metadata)])).toEqual([
        ['studio.project.approve', {}],
      ]);
    });

    it('hides other organisations’ projects from the status route', async () => {
      const id = await readyProject();
      expect((await status(id, 'stranger')).status).toBe(404);
      expect((await approve(id, 'stranger')).status).toBe(404);
    });
  });
});
