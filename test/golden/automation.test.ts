import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as forceApproveRoute from '../../src/app/api/studio/renders/[id]/force-approve/route';
import * as projectsRoute from '../../src/app/api/studio/projects/route';
import * as templatesRoute from '../../src/app/api/studio/templates/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { getKillSwitch } from '../../src/lib/studio/kill-switch';
import { seedOverlayPresets } from '../../src/lib/studio/overlays/seed-presets';
import { seedProjectTemplates } from '../../src/lib/studio/templates/seed';
import { call } from '../helpers/api-harness';
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
  rendersOf,
  startJourney,
  type Journey,
} from './journey-kit';

// Phase 12 automation (track A) golden journeys — spec 5.9 review checkpoint, spec 3
// auto-publish on approval, spec 8.6 templates. Real routes + real workers on the inline queue.
//
//   GA-01  AUTO_APPROVE, untrusted creator → stays in review with "first N videos"
//   GA-02  AUTO_APPROVE, trusted creator → approved by the system → auto-published; a bad
//          target (connection needs reconnecting) is recorded and doesn't block the good one
//   GA-03  Force-approved, content-flagged and script-WARN runs are never auto-approved
//   GA-04  Human approval with AUTO_ON_APPROVAL publishes to the stored targets
//   GA-05  Save a project as a template → new project from it inherits the structure and
//          publish defaults → approve → auto-published; templates are org-isolated

const hasDb = Boolean(process.env.DATABASE_URL);
const HOOK_TIMEOUT_MS = 120_000;

type ReviewMeta = {
  review?: { decision: string; code?: string; reason?: string };
  autoPublishResult?: {
    status: string;
    trigger: string;
    results: Array<{ status: string; error?: string; publicationId?: string }>;
  };
};

describe.skipIf(!hasDb)('automation journeys (Phase 12, track A)', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const since = new Date();

  beforeAll(async () => {
    await seedOverlayPresets(db);
    await seedProjectTemplates(db);
  }, HOOK_TIMEOUT_MS);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.template.deleteMany({ where: { organisationId: { startsWith: ORG_PREFIX } } });
    await cleanupGolden(db, since);
    (await getKillSwitch()).invalidate();
    await db.$disconnect();
  }, HOOK_TIMEOUT_MS);

  const metaOf = async (id: string) =>
    ((await db.videoProject.findUniqueOrThrow({ where: { id } })).metadata ?? {}) as ReviewMeta;

  /** Earlier projects of user-1 in this org, approved by a person (or by the system). */
  async function priorApprovals(j: Journey, humans: number, system = 0) {
    for (let i = 0; i < humans + system; i += 1) {
      const project = await db.videoProject.create({
        data: {
          organisationId: j.org,
          businessId: BUSINESS_ID,
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
          resolvedByUserId: i < humans ? 'reviewer-7' : 'system:auto-approve',
          resolvedAt: new Date(),
        },
      });
    }
  }

  it('GA-01 untrusted creator: AUTO_APPROVE stays in review with the reason', async () => {
    vi.stubEnv('STUDIO_AUTO_APPROVE_TRUST_THRESHOLD', '2');
    const j = startJourney(db, 'ga01');
    // One human approval and one automatic one: auto-approvals never build trust.
    await priorApprovals(j, 1, 1);
    const id = await createProject(j, briefBody({ reviewPolicy: 'AUTO_APPROVE' }));
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
    expect((await metaOf(id)).review).toMatchObject({
      decision: 'needs_review',
      code: 'not_trusted',
      reason: expect.stringContaining('first 2 videos — 1 of 2'),
    });
    expect(await db.approvalTask.count({ where: { projectId: id } })).toBe(0);
  });

  it('GA-02 trusted creator: auto-approved, auto-published; a bad target does not block', async () => {
    vi.stubEnv('STUDIO_AUTO_APPROVE_TRUST_THRESHOLD', '2');
    const j = startJourney(db, 'ga02');
    await priorApprovals(j, 2);
    const good = await connect(j, 'tiktok');
    const stale = await connect(j, 'tiktok');
    await db.platformConnection.update({
      where: { id: stale.id },
      data: { state: 'needs_reconnect' },
    });
    const id = await createProject(
      j,
      briefBody({
        reviewPolicy: 'AUTO_APPROVE',
        publishPolicy: 'AUTO_ON_APPROVAL',
        autoPublish: {
          targets: [
            { platform: 'tiktok', connectionId: stale.id },
            { platform: 'tiktok', connectionId: good.id, caption: 'Fresh sourdough' },
          ],
        },
      }),
    );
    const done = await generate(j, id);
    expect(done.state).toBe('PUBLISHED');

    const [approval] = await db.approvalTask.findMany({ where: { projectId: id } });
    expect(approval).toMatchObject({ state: 'APPROVED', resolvedByUserId: 'system:auto-approve' });
    const meta = await metaOf(id);
    expect(meta.review).toMatchObject({ decision: 'auto_approved' });
    expect(meta.autoPublishResult).toMatchObject({ status: 'partial', trigger: 'auto' });
    expect(meta.autoPublishResult?.results[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('reconnect'),
    });
    expect(meta.autoPublishResult?.results[1]).toMatchObject({ status: 'created' });
    const publications = await db.videoPublication.findMany({ where: { projectId: id } });
    expect(publications).toHaveLength(1);
    expect(publications[0]).toMatchObject({ state: 'PUBLISHED', caption: 'Fresh sourdough' });
    expect(j.h.publishers.tiktok.published).toHaveLength(1);
    expect(j.h.audits.map((a) => [a.action, a.actorUserId])).toEqual(
      expect.arrayContaining([
        ['studio.project.auto_approve', 'system:auto-approve'],
        ['studio.publication.publish', 'system:auto-publish'],
      ]),
    );
    // An auto-approval does not count toward the creator's trust.
    expect(
      await db.videoProject.count({
        where: {
          organisationId: j.org,
          approvals: { some: { resolvedByUserId: { not: { startsWith: 'system:' } } } },
        },
      }),
    ).toBe(2);
  });

  it('GA-03 force-approved, flagged and script-WARN runs are never auto-approved', async () => {
    vi.stubEnv('STUDIO_AUTO_APPROVE_TRUST_THRESHOLD', '1');
    // Quality failure → force-approve → back in review, but never approved automatically.
    const forced = startJourney(db, 'ga03a', { loudness: -30 });
    await priorApprovals(forced, 1);
    const forcedId = await createProject(forced, briefBody({ reviewPolicy: 'AUTO_APPROVE' }));
    expect((await generate(forced, forcedId)).state).toBe('QUALITY_FAILED');
    const [render] = await rendersOf(forced, forcedId);
    const res = await call(forceApproveRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: render?.id ?? '' },
      body: { note: 'Quiet on purpose' },
    });
    expect(res.status).toBe(200);
    expect((await getProject(forced, forcedId)).state).toBe('READY_FOR_REVIEW');
    expect(await db.approvalTask.count({ where: { projectId: forcedId } })).toBe(0);

    // Content-safety "review"-level flag → paused for a Trust & Safety review (13.17: it used to
    // be QUALITY_FAILED), no approval.
    const flagged = startJourney(db, 'ga03b', { hiveMaxScores: { general_suggestive: 0.95 } });
    await priorApprovals(flagged, 1);
    const flaggedId = await createProject(flagged, briefBody({ reviewPolicy: 'AUTO_APPROVE' }));
    expect((await generate(flagged, flaggedId)).state).toBe('QUALITY_CHECKING');
    expect(await db.safetyReview.count({ where: { projectId: flaggedId, state: 'PENDING' } })).toBe(
      1,
    );
    expect(await db.approvalTask.count({ where: { projectId: flaggedId } })).toBe(0);

    // Script safety WARN passes generation but always goes to a person.
    const warned = startJourney(db, 'ga03c', {
      safety: { verdict: 'WARN', categories: [], reason: 'borderline claim' },
    });
    await priorApprovals(warned, 1);
    const warnedId = await createProject(warned, briefBody({ reviewPolicy: 'AUTO_APPROVE' }));
    expect((await generate(warned, warnedId)).state).toBe('READY_FOR_REVIEW');
    expect((await metaOf(warnedId)).review).toMatchObject({ code: 'script_safety_flag' });
  });

  it('GA-04 human approval with AUTO_ON_APPROVAL publishes to the stored targets', async () => {
    const j = startJourney(db, 'ga04');
    const conn = await connect(j, 'tiktok');
    const id = await createProject(
      j,
      briefBody({
        publishPolicy: 'AUTO_ON_APPROVAL',
        autoPublish: {
          targets: [{ platform: 'tiktok', connectionId: conn.id, hashtags: ['#Leeds'] }],
        },
      }),
    );
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
    await approve(j, id);
    expect((await getProject(j, id)).state).toBe('PUBLISHING');
    await drain(j);
    expect((await getProject(j, id)).state).toBe('PUBLISHED');
    expect((await metaOf(id)).autoPublishResult).toMatchObject({
      status: 'created',
      trigger: 'human',
    });
    const [approval] = await db.approvalTask.findMany({ where: { projectId: id } });
    expect(approval?.resolvedByUserId).toBe('user-1');
  });

  it('GA-05 template: save → create from it → inherits structure and publish defaults', async () => {
    const j = startJourney(db, 'ga05');
    const conn = await connect(j, 'tiktok');
    const sourceId = await createProject(
      j,
      briefBody({
        publishPolicy: 'AUTO_ON_APPROVAL',
        autoPublish: { targets: [{ platform: 'tiktok', connectionId: conn.id }] },
      }),
    );
    expect((await generate(j, sourceId)).state).toBe('READY_FOR_REVIEW');
    const saved = await call(templatesRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: { projectId: sourceId, name: 'Weekly bake', category: 'weekly' },
    });
    expect(saved.status).toBe(201);
    const templateId = (saved.json.template as { id: string }).id;

    const listed = await call(templatesRoute.GET, {
      token: 'reader',
      path: '/api/studio/templates?category=weekly',
    });
    expect((listed.json.data as Array<{ id: string }>).map((t) => t.id)).toEqual([templateId]);

    const created = await call(projectsRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: {
        name: 'Rye week',
        businessId: BUSINESS_ID,
        sourceType: 'TEMPLATE',
        templateId,
        brief: { rawInput: 'This week: dark rye' },
      },
    });
    expect(created.status).toBe(201);
    const project = created.json.project as { id: string; publishPolicy: string };
    expect(project.publishPolicy).toBe('AUTO_ON_APPROVAL');
    const before = j.h.adapters.anthropic.requests.length;
    expect((await generate(j, project.id)).state).toBe('READY_FOR_REVIEW');
    // The template's shot blueprint constrained Layer 2 like a library TEMPLATE reference.
    const prompts = j.h.adapters.anthropic.requests.slice(before).map((r) => JSON.stringify(r));
    expect(
      prompts.some((p) => p.includes('STRUCTURE TEMPLATE') && p.includes('Exactly 3 shots')),
    ).toBe(true);
    await approve(j, project.id);
    await drain(j);
    expect((await getProject(j, project.id)).state).toBe('PUBLISHED');
    expect(j.h.publishers.tiktok.published).toHaveLength(1);

    // Templates are organisation-scoped: another organisation neither sees nor uses it.
    const other = startJourney(db, 'ga05-other');
    const otherList = await call(templatesRoute.GET, { token: 'reader' });
    expect((otherList.json.data as Array<{ id: string }>).some((t) => t.id === templateId)).toBe(
      false,
    );
    const refused = await call(projectsRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: { name: 'x', businessId: BUSINESS_ID, sourceType: 'TEMPLATE', templateId },
    });
    expect(refused.status).toBe(400);
    expect(other.org).not.toBe(j.org);
  });
});
