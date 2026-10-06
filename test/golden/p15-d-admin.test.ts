import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as forceApprovalsRoute from '../../src/app/api/studio/admin/force-approvals/route';
import * as confirmRoute from '../../src/app/api/studio/admin/kill-switch/global/confirm/route';
import * as pendingRoute from '../../src/app/api/studio/admin/kill-switch/global/pending/route';
import * as killSwitchRoute from '../../src/app/api/studio/admin/kill-switch/route';
import * as requeueRoute from '../../src/app/api/studio/admin/queues/[name]/failed/[jobId]/requeue/route';
import * as drainRoute from '../../src/app/api/studio/admin/queues/[name]/failed/drain/route';
import * as failedRoute from '../../src/app/api/studio/admin/queues/[name]/failed/route';
import * as forceApproveRoute from '../../src/app/api/studio/renders/[id]/force-approve/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { QUEUES } from '../../src/lib/studio/queue/queues';
import { inlineDeadLetterQueues } from '../../src/lib/studio/services/dead-letter';
import { PENDING_GLOBAL_KILL_KEY } from '../../src/lib/studio/services/kill-switch-admin';
import { call, tenant } from '../helpers/api-harness';
import type { HarnessOptions } from '../helpers/pipeline-harness';
import {
  cleanupGolden,
  createProject,
  drain,
  generate,
  getProject,
  ORG_PREFIX,
  rendersOf,
  startJourney,
} from './journey-kit';

// Phase 15 Track D admin journeys (15.D4–15.D6), through the real routes and workers (inline
// queue):
//
//   GD-01  A generate-asset job dead-letters (Runway refuses the prompt); staff inspect it,
//          requeue it with a different provider preference, the project's asset stage resumes and
//          reaches review; the leftover old-run jobs are drained with a typed confirmation.
//   GD-02  A customer force-approves a quality failure; staff review it in the Admin Centre list.
//   GD-03  A global kill request cannot be confirmed by its requester and can be withdrawn. (The
//          actual flip is covered in test/api/kill-switch-admin.test.ts: a real global kill here
//          would halt the other golden files running in parallel.)

const hasDb = Boolean(process.env.DATABASE_URL);
const HOOK_TIMEOUT_MS = 120_000;
const STAFF_ORG = `${ORG_PREFIX}-p15d-staff`;
const STAFF_CAPS = [
  'studio:admin:providers',
  'studio:admin:redrive',
  'studio:admin:moderation',
  'studio:admin:kill-switch:read',
  'studio:admin:kill-switch:write',
];

describe.skipIf(!hasDb)('Phase 15 Track D admin journeys', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const since = new Date();

  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    setApiDeps(undefined);
    await db.systemFlag.deleteMany({ where: { key: PENDING_GLOBAL_KILL_KEY } });
    await cleanupGolden(db, since);
    await db.$disconnect();
  }, HOOK_TIMEOUT_MS);

  const journey = (id: string, options: HarnessOptions = {}) => {
    vi.stubEnv('STUDIO_PLATFORM_ORG_IDS', STAFF_ORG);
    const j = startJourney(db, id, options, {
      staff: tenant(STAFF_ORG, STAFF_CAPS, 'staff-1'),
      staff2: tenant(STAFF_ORG, STAFF_CAPS, 'staff-2'),
    });
    j.api.deps.deadLetterQueues = () => inlineDeadLetterQueues(j.h.queue);
    return j;
  };

  it('GD-01 dead-lettered asset job → inspect → requeue with another provider → review', async () => {
    const j = journey('gd01', {
      runwayRespond: () => ({
        state: 'failed',
        error: { class: 'invalid_request', message: 'prompt refused', retryable: false },
      }),
    });
    const projectId = await createProject(j);
    const failed = await generate(j, projectId, { expectClean: false });
    expect(failed.state).toBe('FAILED');
    expect(failed.errorReason).toMatch(/^asset_generation_failed/);

    const list = await call(failedRoute.GET, {
      token: 'staff',
      params: { name: QUEUES.assets },
    });
    expect(list.status).toBe(200);
    const jobs = (list.json.jobs as Array<Record<string, unknown>>).filter(
      (job) => job.projectId === projectId,
    );
    expect(jobs.length).toBeGreaterThan(0);
    const [job] = jobs;
    expect(job).toMatchObject({ name: 'generate-asset', providerOverride: true, attemptsMade: 1 });
    expect(String(job?.failedReason)).toMatch(/runway\/invalid_request/);

    // A provider that is not a router candidate for this shot on STANDARD is refused.
    const refused = await call(requeueRoute.POST, {
      method: 'POST',
      token: 'staff',
      params: { name: QUEUES.assets, jobId: String(job?.id) },
      body: { providerId: 'heygen' },
    });
    expect(refused.status).toBe(400);
    expect(refused.json.details).toMatchObject({
      candidates: ['seedance', 'kling', 'veo', 'runway', 'luma', 'fal'],
    });

    // Runway accepts the prompt again; Luma is preferred but not configured in this deployment,
    // so the router records it as skipped and falls back to Runway.
    j.h.adapters.runway.respond = () => ({
      state: 'succeeded',
      output: { url: 'https://runway.invalid/clip.mp4', metadata: { costPence: 45 } },
    });
    const requeued = await call(requeueRoute.POST, {
      method: 'POST',
      token: 'staff',
      params: { name: QUEUES.assets, jobId: String(job?.id) },
      body: { providerId: 'luma', reason: 'Runway refusing prompts' },
    });
    expect(requeued.status).toBe(200);
    expect(requeued.json.outcome).toMatchObject({
      action: 'resumed_project',
      projectId,
      providerId: 'luma',
    });
    expect(j.api.audits.at(-1)).toMatchObject({
      action: 'studio.dead_letter.requeue',
      metadata: { providerId: 'luma' },
    });

    await drain(j);
    expect((await getProject(j, projectId)).state).toBe('READY_FOR_REVIEW');
    const shot = await db.videoShot.findUniqueOrThrow({
      where: { id: String((job?.data as { shotId: string }).shotId) },
    });
    expect(shot.state).toBe('READY');
    expect(shot.providerRouting).toMatchObject({ preferredProviderId: 'luma' });

    // Other shots' jobs from the failed run are still dead-lettered: drain them deliberately.
    const leftover = j.h.queue.failed.filter((f) => f.name === 'generate-asset').length;
    const drained = await call(drainRoute.POST, {
      method: 'POST',
      token: 'staff',
      params: { name: QUEUES.assets },
      body: { confirm: QUEUES.assets, reason: 'superseded by the resumed run' },
    });
    expect(drained.status).toBe(200);
    expect(drained.json.removed).toBe(leftover);
    expect(j.h.queue.failed.filter((f) => f.name === 'generate-asset')).toEqual([]);
  });

  it('GD-02 a customer force-approve is reviewable in the Admin Centre', async () => {
    const j = journey('gd02', { loudness: -30 });
    const projectId = await createProject(j);
    expect((await generate(j, projectId)).state).toBe('QUALITY_FAILED');
    const [render] = await rendersOf(j, projectId);
    const forced = await call(forceApproveRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: render?.id ?? '' },
      body: { note: 'Quiet on purpose: ASMR bakery' },
    });
    expect(forced.status).toBe(200);

    const res = await call(forceApprovalsRoute.GET, {
      token: 'staff',
      path: `/api/studio/admin/force-approvals?days=1&organisationId=${j.org}`,
    });
    expect(res.status).toBe(200);
    expect(res.json.items).toEqual([
      expect.objectContaining({
        renderId: render?.id,
        approvedByUserId: 'user-1',
        note: 'Quiet on purpose: ASMR bakery',
        approvedAtRecorded: true,
        organisationId: j.org,
        project: expect.objectContaining({ id: projectId }),
        failedChecks: expect.arrayContaining([
          expect.objectContaining({ code: 'audio_present', detail: expect.stringMatching(/LUFS/) }),
        ]),
      }),
    ]);
    // The customer cannot read the staff view.
    expect((await call(forceApprovalsRoute.GET, { token: 'owner' })).status).toBe(403);
  });

  it('GD-03 a global kill request needs a second person and can be withdrawn', async () => {
    const j = journey('gd03');
    await db.systemFlag.deleteMany({ where: { key: PENDING_GLOBAL_KILL_KEY } });
    const requested = await call(killSwitchRoute.PUT, {
      method: 'PUT',
      token: 'staff',
      body: { level: 'global', enabled: true, reason: 'Rehearsal: cost runaway' },
    });
    expect(requested.status).toBe(202);
    const { requestId } = requested.json.pending as { requestId: string };
    const state = await call(killSwitchRoute.GET, { token: 'staff2' });
    expect(state.json).toMatchObject({
      global: { enabled: false },
      pendingGlobal: { requestId, requestedBy: 'staff-1', requestedByYou: false },
    });
    const self = await call(confirmRoute.POST, {
      method: 'POST',
      token: 'staff',
      body: { requestId, reason: 'approving my own' },
    });
    expect(self.status).toBe(403);
    const withdrawn = await call(pendingRoute.DELETE, { method: 'DELETE', token: 'staff2' });
    expect(withdrawn.status).toBe(200);
    expect(j.api.audits.map((a) => a.action)).toEqual([
      'studio.kill_switch.global_requested',
      'studio.kill_switch.global_request_withdrawn',
    ]);
    expect((await call(killSwitchRoute.GET, { token: 'staff' })).json.pendingGlobal).toBeNull();
  });
});
