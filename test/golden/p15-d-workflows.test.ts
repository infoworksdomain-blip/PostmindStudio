import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as workflowsRoute from '../../src/app/api/studio/approval-workflows/route';
import * as approvalRoute from '../../src/app/api/studio/projects/[id]/approval/route';
import * as approveRoute from '../../src/app/api/studio/projects/[id]/approve/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { getKillSwitch } from '../../src/lib/studio/kill-switch';
import type { TenantContext } from '../../src/lib/tenant';
import { ALL_CAPABILITIES, call, tenant } from '../helpers/api-harness';
import {
  approve,
  BUSINESS_ID,
  briefBody,
  cleanupGolden,
  connect,
  createProject,
  drain,
  generate,
  getProject,
  ORG_PREFIX,
  startJourney,
  type Journey,
} from './journey-kit';

// 15.D3 golden journeys — multi-step approval workflows (spec 7.13, 3.3 agency) on the real
// routes and workers:
//
//   GW-01  An agency's "Client sign-off" workflow (admin → 2 client reviewers) applies to the
//          client's business: a trusted AUTO_APPROVE project is NOT auto-approved, stays in
//          review through step 1 and the first client approval, and auto-publishes only after
//          the last approval.
//   GW-02  Another business of the same organisation has no workflow: one approval, as before.

const hasDb = Boolean(process.env.DATABASE_URL);
const HOOK_TIMEOUT_MS = 120_000;

describe.skipIf(!hasDb)('approval workflow journeys (15.D3)', { timeout: 180_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const since = new Date();

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    setApiDeps(undefined);
    const org = { startsWith: ORG_PREFIX };
    const ids = (
      await db.videoProject.findMany({ where: { organisationId: org }, select: { id: true } })
    ).map((p) => p.id);
    await db.autoPublishOutbox.deleteMany({ where: { projectId: { in: ids } } });
    await db.approvalWorkflow.deleteMany({ where: { organisationId: org } });
    await cleanupGolden(db, since);
    (await getKillSwitch()).invalidate();
    await db.$disconnect();
  }, HOOK_TIMEOUT_MS);

  function people(orgId: string): Record<string, TenantContext> {
    const as = (userId: string, role: string): TenantContext => ({
      ...tenant(orgId, ALL_CAPABILITIES, userId),
      memberships: [{ organisationId: orgId, role }],
    });
    return {
      admin: as('agency-admin', 'admin'),
      clientA: as('client-a', 'client_reviewer'),
      clientB: as('client-b', 'client_reviewer'),
    };
  }

  const journey = (id: string) => {
    const org = `${ORG_PREFIX}-${id}`;
    return startJourney(db, id, {}, people(org));
  };

  /** Two earlier projects of user-1 approved by a person: the creator is trusted (13.18). */
  async function trustCreator(j: Journey) {
    for (let i = 0; i < 2; i += 1) {
      const project = await db.videoProject.create({
        data: {
          organisationId: j.org,
          businessId: 'biz-earlier',
          createdByUserId: 'user-1',
          name: `Earlier ${i}`,
          state: 'PUBLISHED',
          sourceType: 'BRIEF',
          targetFormats: [],
        },
      });
      await db.approvalTask.create({
        data: {
          projectId: project.id,
          stepIndex: 0,
          requiredRole: 'reviewer',
          state: 'APPROVED',
          resolvedByUserId: 'reviewer-7',
          resolvedAt: new Date(),
        },
      });
    }
  }

  const approveAs = (id: string, token: string) =>
    call(approveRoute.POST, { method: 'POST', token, params: { id }, body: {} });

  it('GW-01 client sign-off: no auto-approve, three approvals, then auto-publish', async () => {
    vi.stubEnv('STUDIO_AUTO_APPROVE_TRUST_THRESHOLD', '2');
    const j = journey('gw01');
    await trustCreator(j);
    const created = await call(workflowsRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: {
        name: 'Client sign-off',
        steps: [
          { role: 'admin', minApprovers: 1 },
          { role: 'client_reviewer', minApprovers: 2 },
        ],
        appliesTo: { businessIds: [BUSINESS_ID], platforms: ['tiktok'] },
      },
    });
    expect(created.status).toBe(201);
    const workflowId = (created.json.workflow as { id: string }).id;

    const tiktok = await connect(j, 'tiktok');
    const id = await createProject(
      j,
      briefBody({
        reviewPolicy: 'AUTO_APPROVE',
        publishPolicy: 'AUTO_ON_APPROVAL',
        autoPublish: { targets: [{ platform: 'tiktok', connectionId: tiktok.id }] },
      }),
    );
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
    const project = await db.videoProject.findUniqueOrThrow({ where: { id } });
    expect((project.metadata as { review?: unknown }).review).toMatchObject({
      decision: 'needs_review',
      code: 'approval_workflow',
      reason: expect.stringContaining('Client sign-off'),
    });
    expect(await db.approvalTask.count({ where: { projectId: id } })).toBe(0);

    const indicator = await call(approvalRoute.GET, { token: 'reader', params: { id } });
    expect(indicator.json.approval).toMatchObject({
      workflow: { id: workflowId },
      stepIndex: 0,
      stepCount: 2,
      waitingFor: { role: 'admin' },
    });

    const step1 = await approveAs(id, 'admin');
    expect(step1.json.approval).toMatchObject({ stepIndex: 0, remainingSteps: 1 });
    const step2a = await approveAs(id, 'clientA');
    expect(step2a.json.approval).toMatchObject({ stepIndex: 1, remainingSteps: 1 });
    await drain(j);
    expect((await getProject(j, id)).state).toBe('READY_FOR_REVIEW');
    expect(j.h.publishers.tiktok.published).toHaveLength(0);

    const step2b = await approveAs(id, 'clientB');
    expect(step2b.status).toBe(200);
    expect(step2b.json.approval).toMatchObject({ stepIndex: 1, remainingSteps: 0 });
    await drain(j);
    expect((await getProject(j, id)).state).toBe('PUBLISHED');
    expect(j.h.publishers.tiktok.published).toHaveLength(1);

    const outbox = await db.autoPublishOutbox.findMany({ where: { projectId: id } });
    const finalTask = await db.approvalTask.findFirstOrThrow({
      where: { projectId: id, resolvedByUserId: 'client-b' },
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.approvalTaskId).toBe(finalTask.id);
    expect(finalTask).toMatchObject({ workflowId, stepIndex: 1, state: 'APPROVED' });
  });

  it('GW-02 a business without a workflow keeps the single approval', async () => {
    const j = journey('gw02');
    await call(workflowsRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: {
        name: 'Other client',
        steps: [{ role: 'client_reviewer', minApprovers: 1 }],
        appliesTo: { businessIds: ['biz-someone-else'] },
      },
    });
    const id = await createProject(j);
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
    await approve(j, id);
    expect(await db.approvalTask.findMany({ where: { projectId: id } })).toMatchObject([
      { workflowId: null, stepIndex: 0, state: 'APPROVED' },
    ]);
  });
});
