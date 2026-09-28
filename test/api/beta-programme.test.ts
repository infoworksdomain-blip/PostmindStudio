import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as betaDashboardRoute from '../../src/app/api/studio/admin/beta/route';
import * as adminFeedbackRoute from '../../src/app/api/studio/admin/feedback/route';
import * as orgBetaRoute from '../../src/app/api/studio/admin/organisations/[id]/beta/route';
import * as auditResultRoute from '../../src/app/api/studio/admin/safety-audit/[id]/result/route';
import * as auditRoute from '../../src/app/api/studio/admin/safety-audit/route';
import * as auditSampleRoute from '../../src/app/api/studio/admin/safety-audit/sample/route';
import * as feedbackRoute from '../../src/app/api/studio/feedback/route';
import * as generateRoute from '../../src/app/api/studio/projects/[id]/generate/route';
import * as projectsRoute from '../../src/app/api/studio/projects/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { createBetaPlanLookup } from '../../src/lib/studio/services/beta';
import { sampleSafetyAuditJob } from '../../src/lib/studio/queue/workers/sample-safety-audit';
import type { PipelineDeps } from '../../src/lib/studio/pipeline/deps';
import { call, installApi, tenant } from '../helpers/api-harness';

// BACKLOG 14.11 — beta cohort (+ the "Plus for 30 days" override reaching generation), in-app
// feedback, the staff beta dashboard and the Trust & Safety monthly audit, on a real database.

const hasDb = Boolean(process.env.DATABASE_URL);
const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!hasDb)('beta programme API (14.11)', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const staffOrg = `api-beta-staff-${randomUUID()}`;
  const org = `api-beta-org-${randomUUID()}`;
  const otherOrg = `api-beta-other-${randomUUID()}`;
  const cohort = `c${randomUUID().slice(0, 8)}`;
  const tokens = {
    staff: tenant(staffOrg, ['studio:admin:moderation', 'studio:admin:providers'], 'staff-1'),
    outsider: tenant(org, ['studio:admin:moderation', 'studio:admin:providers']),
    owner: tenant(org),
    other: tenant(otherOrg, undefined, 'user-9'),
  };
  let api: ReturnType<typeof installApi>;

  beforeEach(() => {
    api = installApi(db, tokens);
    api.deps.betaPlans = createBetaPlanLookup({
      db,
      logger: pino({ level: 'silent' }),
      now: Date.now,
    });
    vi.stubEnv('STUDIO_PLATFORM_ORG_IDS', staffOrg);
  });

  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    setApiDeps(undefined);
    const orgs = [org, otherOrg];
    await db.organisationBeta.deleteMany({ where: { organisationId: { in: orgs } } });
    await db.betaFeedback.deleteMany({ where: { organisationId: { in: orgs } } });
    await db.safetyAuditItem.deleteMany({ where: { organisationId: { in: orgs } } });
    await db.notification.deleteMany({ where: { organisationId: { in: [...orgs, staffOrg] } } });
    await db.videoPublication.deleteMany({ where: { organisationId: { in: orgs } } });
    const ids = (
      await db.videoProject.findMany({
        where: { organisationId: { in: orgs } },
        select: { id: true },
      })
    ).map((p) => p.id);
    await db.videoRender.deleteMany({ where: { projectId: { in: ids } } });
    await db.approvalTask.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.providerUsage.deleteMany({ where: { organisationId: { in: orgs } } });
    await db.$disconnect();
  });

  async function createProject(token = 'owner') {
    const res = await call(projectsRoute.POST, {
      method: 'POST',
      token,
      body: {
        name: 'Beta video',
        businessId: 'biz-1',
        brief: { rawInput: 'Launch our sourdough subscription' },
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 30 }],
        costBudgetPence: 500,
      },
    });
    expect(res.status).toBe(201);
    return (res.json.project as { id: string }).id;
  }

  describe('beta cohort', () => {
    it('is staff only', async () => {
      expect(
        (await call(orgBetaRoute.GET, { token: 'outsider', params: { id: org } })).status,
      ).toBe(403);
      const put = await call(orgBetaRoute.PUT, {
        method: 'PUT',
        token: 'owner',
        params: { id: org },
        body: { cohort },
      });
      expect(put.status).toBe(403);
    });

    it('GET reports no beta before enrolment; PUT validates', async () => {
      const res = await call(orgBetaRoute.GET, { token: 'staff', params: { id: org } });
      expect(res.json).toMatchObject({ organisationId: org, beta: null });
      const bad = await call(orgBetaRoute.PUT, {
        method: 'PUT',
        token: 'staff',
        params: { id: org },
        body: { cohort: 'Not Valid' },
      });
      expect(bad.status).toBe(400);
      const past = await call(orgBetaRoute.PUT, {
        method: 'PUT',
        token: 'staff',
        params: { id: org },
        body: { cohort, plusUntil: new Date(Date.now() - DAY).toISOString() },
      });
      expect(past.status).toBe(400);
    });

    it('generation before enrolment runs at the Core tier (STANDARD)', async () => {
      const id = await createProject();
      const res = await call(generateRoute.POST, {
        method: 'POST',
        token: 'owner',
        params: { id },
      });
      expect(res.json).toMatchObject({ planTier: 'STANDARD' });
    });

    it('PUT enrols with Plus for 30 days, audits, and generation then runs as PLUS', async () => {
      const res = await call(orgBetaRoute.PUT, {
        method: 'PUT',
        token: 'staff',
        params: { id: org },
        body: { cohort },
      });
      expect(res.status).toBe(200);
      const beta = res.json.beta as { plusUntil: string; plusActive: boolean; cohort: string };
      expect(beta).toMatchObject({ cohort, plusActive: true });
      const days = (Date.parse(beta.plusUntil) - Date.now()) / DAY;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThanOrEqual(30);
      expect(api.audits.at(-1)).toMatchObject({
        action: 'studio.admin.beta.update',
        actorUserId: 'staff-1',
        resource: { type: 'organisation', id: org },
        metadata: { before: null, after: { cohort } },
      });

      const id = await createProject();
      const run = await call(generateRoute.POST, {
        method: 'POST',
        token: 'owner',
        params: { id },
      });
      expect(run.status).toBe(202);
      expect(run.json).toMatchObject({ planTier: 'PLUS' });
      expect(api.queue.history.at(-1)).toMatchObject({
        name: 'plan-project',
        data: { projectId: id, planTier: 'PLUS' },
      });
    });

    it('plusUntil null keeps the cohort but ends the override', async () => {
      const res = await call(orgBetaRoute.PUT, {
        method: 'PUT',
        token: 'staff',
        params: { id: org },
        body: { cohort, plusUntil: null },
      });
      expect(res.json.beta).toMatchObject({ plusUntil: null, plusActive: false });
      const id = await createProject();
      const run = await call(generateRoute.POST, {
        method: 'POST',
        token: 'owner',
        params: { id },
      });
      expect(run.json).toMatchObject({ planTier: 'STANDARD' });
      // Back on Plus for the dashboard test below.
      await call(orgBetaRoute.PUT, {
        method: 'PUT',
        token: 'staff',
        params: { id: org },
        body: { cohort, plusUntil: new Date(Date.now() + 10 * DAY).toISOString() },
      });
    });
  });

  describe('feedback', () => {
    it('POST stores feedback for the caller, validates and audits without the message', async () => {
      const res = await call(feedbackRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: { kind: 'bug', message: '  The preview froze  ', screen: '/projects' },
      });
      expect(res.status).toBe(201);
      expect(res.json.feedback).toMatchObject({
        organisationId: org,
        userId: 'user-1',
        kind: 'bug',
        message: 'The preview froze',
        screen: '/projects',
      });
      expect(api.audits.at(-1)).toMatchObject({ action: 'studio.feedback.create' });
      expect(JSON.stringify(api.audits.at(-1))).not.toContain('preview froze');

      const cases = [
        { kind: 'rant', message: 'x', screen: '/' },
        { kind: 'bug', message: '', screen: '/' },
        { kind: 'bug', message: 'x'.repeat(2001), screen: '/' },
        { kind: 'bug', message: 'x', screen: 'https://evil.test' },
        { kind: 'bug', message: 'x', screen: '/', extra: 1 },
      ];
      for (const body of cases)
        expect(
          (await call(feedbackRoute.POST, { method: 'POST', token: 'owner', body })).status,
        ).toBe(400);
    });

    it('a projectId must belong to the caller’s organisation', async () => {
      const id = await createProject();
      const ok = await call(feedbackRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: { kind: 'idea', message: 'More voices', screen: `/projects/${id}`, projectId: id },
      });
      expect(ok.status).toBe(201);
      const other = await call(feedbackRoute.POST, {
        method: 'POST',
        token: 'other',
        body: { kind: 'idea', message: 'x', screen: '/projects', projectId: id },
      });
      expect(other.status).toBe(404);
    });

    it('rate-limits a user to 10 an hour with Retry-After', async () => {
      for (let i = 0; i < 10; i++)
        await call(feedbackRoute.POST, {
          method: 'POST',
          token: 'other',
          body: { kind: 'other', message: `note ${i}`, screen: '/calendar' },
        });
      const limited = await call(feedbackRoute.POST, {
        method: 'POST',
        token: 'other',
        body: { kind: 'other', message: 'one more', screen: '/calendar' },
      });
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await db.betaFeedback.count({ where: { organisationId: otherOrg } })).toBe(10);
    });

    it('staff list filters by kind, organisation and cohort; not for customers', async () => {
      expect((await call(adminFeedbackRoute.GET, { token: 'owner' })).status).toBe(403);
      const bugs = await call(adminFeedbackRoute.GET, {
        token: 'staff',
        path: `/api/studio/admin/feedback?kind=bug&organisationId=${org}`,
      });
      expect(bugs.status).toBe(200);
      expect(bugs.json.data).toEqual([
        expect.objectContaining({ kind: 'bug', organisationId: org }),
      ]);
      const byCohort = await call(adminFeedbackRoute.GET, {
        token: 'staff',
        path: `/api/studio/admin/feedback?cohort=${cohort}&limit=1`,
      });
      expect(byCohort.json).toMatchObject({ hasMore: true });
      expect((byCohort.json.data as Array<{ organisationId: string }>)[0]?.organisationId).toBe(
        org,
      );
      expect(
        (await call(adminFeedbackRoute.GET, { token: 'staff', path: '/x?kind=rant' })).status,
      ).toBe(400);
    });
  });

  describe('beta dashboard', () => {
    it('reports usage, failures, cost and feedback for cohort organisations', async () => {
      const projects = await db.videoProject.findMany({
        where: { organisationId: org },
        select: { id: true },
      });
      await db.videoProject.update({
        where: { id: projects[0]!.id },
        data: { state: 'READY_FOR_REVIEW' },
      });
      await db.videoProject.update({ where: { id: projects[1]!.id }, data: { state: 'FAILED' } });
      await db.providerUsage.create({
        data: {
          organisationId: org,
          provider: 'runway',
          day: new Date(new Date().toISOString().slice(0, 10)),
          costPence: 420,
        },
      });
      expect((await call(betaDashboardRoute.GET, { token: 'owner' })).status).toBe(403);
      const res = await call(betaDashboardRoute.GET, {
        token: 'staff',
        path: `/api/studio/admin/beta?cohort=${cohort}&days=7`,
      });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ days: 7, cohorts: [cohort] });
      expect(res.json.organisations).toEqual([
        expect.objectContaining({
          organisationId: org,
          cohort,
          plusActive: true,
          videosGenerated: 1,
          videosFailed: 1,
          failureRate: 0.5,
          costPence: 420,
          feedbackCount: 2,
        }),
      ]);
      expect((res.json.recentFeedback as unknown[]).length).toBe(2);
    });
  });

  describe('Trust & Safety monthly audit', () => {
    const period = '2001-02';

    async function published(n: number) {
      const project = await db.videoProject.create({
        data: {
          organisationId: org,
          businessId: 'biz',
          createdByUserId: 'user-1',
          name: 'Published',
          state: 'PUBLISHED',
          sourceType: 'BRIEF',
          targetFormats: [],
        },
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
          s3Key: `orgs/${org}/renders/${randomUUID()}.mp4`,
          qualityCheckState: 'PASSED',
        },
      });
      for (let i = 0; i < n; i++)
        await db.videoPublication.create({
          data: {
            organisationId: org,
            projectId: project.id,
            renderId: render.id,
            platform: 'tiktok',
            platformAccountId: 'acct',
            state: 'PUBLISHED',
            publishedAt: new Date(Date.UTC(2001, 1, 3 + i)),
            platformUrl: `https://www.tiktok.com/@x/video/${i}`,
          },
        });
    }

    it('samples published videos of the period, idempotently, staff only', async () => {
      await published(4);
      expect(
        (
          await call(auditSampleRoute.POST, {
            method: 'POST',
            token: 'owner',
            body: { period, sampleSize: 3 },
          })
        ).status,
      ).toBe(403);
      const first = await call(auditSampleRoute.POST, {
        method: 'POST',
        token: 'staff',
        body: { period, sampleSize: 3 },
      });
      expect(first.status).toBe(200);
      expect(first.json.sample).toMatchObject({ period, added: 3, total: 3, population: 4 });
      const again = await call(auditSampleRoute.POST, {
        method: 'POST',
        token: 'staff',
        body: { period, sampleSize: 3 },
      });
      expect(again.json.sample).toMatchObject({ added: 0, total: 3 });
      const topUp = await call(auditSampleRoute.POST, {
        method: 'POST',
        token: 'staff',
        body: { period, sampleSize: 10 },
      });
      expect(topUp.json.sample).toMatchObject({ added: 1, total: 4 });
      expect(
        (
          await call(auditSampleRoute.POST, {
            method: 'POST',
            token: 'staff',
            body: { period: '2001-13' },
          })
        ).status,
      ).toBe(400);
    });

    it('lists the queue with previews; pass and miss are recorded once; a miss notifies staff', async () => {
      const list = await call(auditRoute.GET, {
        token: 'staff',
        path: `/api/studio/admin/safety-audit?period=${period}`,
      });
      expect(list.status).toBe(200);
      const items = list.json.data as Array<{ id: string; previewUrl: string | null }>;
      expect(items).toHaveLength(4);
      expect(items.every((i) => typeof i.previewUrl === 'string')).toBe(true);
      expect(list.json.summary).toMatchObject({ sampled: 4, pending: 4, missRate: null });
      expect(list.json.periods).toContain(period);

      const [a, b] = items as unknown as [{ id: string }, { id: string }];
      const pass = await call(auditResultRoute.POST, {
        method: 'POST',
        token: 'staff',
        params: { id: a.id },
        body: { result: 'pass' },
      });
      expect(pass.status).toBe(200);
      expect(pass.json.item).toMatchObject({ result: 'pass', reviewedByUserId: 'staff-1' });
      expect(api.audits.at(-1)).toMatchObject({ action: 'studio.safety_audit.record' });

      const noNote = await call(auditResultRoute.POST, {
        method: 'POST',
        token: 'staff',
        params: { id: b.id },
        body: { result: 'miss' },
      });
      expect(noNote.status).toBe(400);
      const miss = await call(auditResultRoute.POST, {
        method: 'POST',
        token: 'staff',
        params: { id: b.id },
        body: { result: 'miss', note: 'Shows a weapon; should have been reviewed' },
      });
      expect(miss.status).toBe(200);
      const told = await db.notification.findFirst({
        where: { organisationId: staffOrg, kind: 'safety_review' },
      });
      expect(told).toMatchObject({ link: '/admin?tab=safety-audit' });

      const twice = await call(auditResultRoute.POST, {
        method: 'POST',
        token: 'staff',
        params: { id: a.id },
        body: { result: 'miss', note: 'changed my mind' },
      });
      expect(twice.status).toBe(409);
      expect(
        (
          await call(auditResultRoute.POST, {
            method: 'POST',
            token: 'staff',
            params: { id: 'nope' },
            body: { result: 'pass' },
          })
        ).status,
      ).toBe(404);

      const misses = await call(auditRoute.GET, {
        token: 'staff',
        path: `/api/studio/admin/safety-audit?period=${period}&result=miss`,
      });
      expect(misses.json.data).toHaveLength(1);
      expect(misses.json.summary).toMatchObject({
        passed: 1,
        missed: 1,
        pending: 2,
        missRate: 0.5,
      });
      expect((await call(auditRoute.GET, { token: 'owner' })).status).toBe(403);
    });

    it('the monthly job samples last month with STUDIO_SAFETY_AUDIT_SAMPLE', async () => {
      const now = Date.UTC(2001, 2, 1, 6);
      const info = vi.fn();
      const deps = {
        db,
        now: () => now,
        logger: { info, error: vi.fn() },
      } as unknown as PipelineDeps;
      await sampleSafetyAuditJob(
        { organisationId: 'postmind-platform', runId: 'safety-audit', planTier: 'STANDARD' },
        deps,
        { STUDIO_SAFETY_AUDIT_SAMPLE: '50' },
      );
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ period, requested: 50, added: 0, total: 4 }),
        'safety audit sample drawn',
      );
      await expect(
        sampleSafetyAuditJob(
          { organisationId: 'postmind-platform', runId: 'x', planTier: 'STANDARD' },
          deps,
          { STUDIO_SAFETY_AUDIT_SAMPLE: '0' },
        ),
      ).rejects.toThrow(/STUDIO_SAFETY_AUDIT_SAMPLE/);
    });
  });
});
