import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as decisionRoute from '../../src/app/api/studio/admin/safety-reviews/[id]/decision/route';
import * as reviewsRoute from '../../src/app/api/studio/admin/safety-reviews/route';
import * as outboxRoute from '../../src/app/api/studio/projects/[id]/auto-publish/route';
import * as approveRoute from '../../src/app/api/studio/projects/[id]/approve/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { costCapsFromEnv } from '../../src/lib/studio/cost/caps';
import { createCostGuard } from '../../src/lib/studio/cost/guard';
import { createOrgCapOverrideLookup } from '../../src/lib/studio/cost/org-overrides';
import { createNotifier } from '../../src/lib/studio/notifications/notifier';
import { getMetrics } from '../../src/lib/studio/observability/metrics';
import { createPrismaBudgetChecker } from '../../src/lib/studio/providers/budget';
import { utcDay } from '../../src/lib/studio/providers/job-repository';
import { resumeCostPausedProjects } from '../../src/lib/studio/services/auto-resume';
import { call, tenant } from '../helpers/api-harness';
import {
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

// Phase 13 track A3 golden journeys: real routes, real workers on the inline queue, real
// Postgres, scripted providers.
//
//   AA-01  Script safety REVIEW pauses planning before any asset spend → staff ALLOW → the run
//          continues from the stored plan → READY_FOR_REVIEW (a person approves it)
//   AA-02  A review-level content-safety flag pauses the quality gate → staff BLOCK → FAILED
//          with the note; the creator is told
//   AA-03  Auto-publish outbox: approval writes the rows; a target whose account needs
//          reconnecting is retried by the dispatcher job after the fix → PUBLISHED
//   AA-04  An organisation cap override pauses generation (org daily); the rollover
//          auto-resume continues the run the next day once the cap allows it

const hasDb = Boolean(process.env.DATABASE_URL);
const HOOK_TIMEOUT_MS = 120_000;
const STAFF_ORG = `${ORG_PREFIX}-staff`;
const DAY_MS = 86_400_000;

describe.skipIf(!hasDb)(
  'golden journeys: Phase 13 admin and automation',
  { timeout: 120_000 },
  () => {
    const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
    const since = new Date();

    afterEach(() => vi.unstubAllEnvs());

    afterAll(async () => {
      setApiDeps(undefined);
      const org = { startsWith: ORG_PREFIX };
      await db.safetyReview.deleteMany({ where: { organisationId: org } });
      await db.autoPublishOutbox.deleteMany({ where: { organisationId: org } });
      await db.orgCostCap.deleteMany({ where: { organisationId: org } });
      await cleanupGolden(db, since);
      await db.$disconnect();
    }, HOOK_TIMEOUT_MS);

    function journey(id: string, options: Parameters<typeof startJourney>[2] = {}): Journey {
      vi.stubEnv('STUDIO_PLATFORM_ORG_IDS', STAFF_ORG);
      return startJourney(db, id, options, {
        staff: tenant(STAFF_ORG, ['studio:admin:moderation'], 'staff-1'),
      });
    }

    const decide = (id: string, decision: 'ALLOW' | 'BLOCK', note: string) =>
      call(decisionRoute.POST, {
        method: 'POST',
        token: 'staff',
        params: { id },
        body: { decision, note },
      });

    async function pendingReviewFor(projectId: string) {
      const res = await call(reviewsRoute.GET, { token: 'staff' });
      expect(res.status).toBe(200);
      const item = (res.json.data as Array<{ id: string; projectId: string; kind: string }>).find(
        (r) => r.projectId === projectId,
      );
      if (!item) throw new Error('expected a pending review');
      return item;
    }

    it('AA-01 script REVIEW pauses before asset spend; ALLOW continues the stored plan', async () => {
      const j = journey('aa01', {
        safety: {
          verdict: 'REVIEW',
          categories: ['medical_misinformation'],
          reason: 'health claim',
        },
      });
      const id = await createProject(j);
      const paused = await generate(j, id);
      expect(paused.state).toBe('PLANNING');
      // No Layer 3 spend while waiting: only text generation ran.
      const clipJobs = () =>
        db.providerJob.count({ where: { projectId: id, operation: { not: 'text_generation' } } });
      expect(await clipJobs()).toBe(0);
      expect(await db.videoShot.count({ where: { script: { projectId: id } } })).toBeGreaterThan(0);

      const review = await pendingReviewFor(id);
      expect(review.kind).toBe('script');
      const res = await decide(review.id, 'ALLOW', 'Claim is about taste, not health');
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ project: { state: 'ASSETS_QUEUED' } });
      await drain(j);
      const done = await getProject(j, id);
      expect(done.state).toBe('READY_FOR_REVIEW');
      expect(await clipJobs()).toBeGreaterThan(0);
    });

    it('AA-02 a review-level content flag pauses the gate; BLOCK fails with the note', async () => {
      const j = journey('aa02', { hiveMaxScores: { general_suggestive: 0.95 } });
      const id = await createProject(j);
      expect((await generate(j, id)).state).toBe('QUALITY_CHECKING');
      const review = await pendingReviewFor(id);
      expect(review.kind).toBe('content');
      const res = await decide(review.id, 'BLOCK', 'Not suitable for a bakery audience');
      expect(res.json).toMatchObject({
        review: { state: 'BLOCKED' },
        project: { state: 'FAILED' },
      });
      const failed = await getProject(j, id);
      expect(failed.errorReason).toBe(
        'content_safety_blocked_by_review: Not suitable for a bakery audience',
      );
      expect(
        await db.notification.count({
          where: { organisationId: j.org, kind: 'safety_review', userId: 'user-1' },
        }),
      ).toBe(2); // opened + decided
    });

    it('AA-03 the outbox retries a target after its account is reconnected', async () => {
      const j = journey('aa03');
      const conn = await connect(j, 'tiktok');
      await db.platformConnection.update({
        where: { id: conn.id },
        data: { state: 'needs_reconnect' },
      });
      const id = await createProject(
        j,
        briefBody({
          publishPolicy: 'AUTO_ON_APPROVAL',
          autoPublish: { targets: [{ platform: 'tiktok', connectionId: conn.id }] },
        }),
      );
      expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
      const approved = await call(approveRoute.POST, {
        method: 'POST',
        token: 'owner',
        params: { id },
        body: { note: 'Go' },
      });
      expect(approved.status).toBe(200);
      expect(approved.json.autoPublish).toMatchObject({
        status: 'failed',
        results: [
          {
            status: 'failed',
            error: expect.stringContaining('reconnect'),
            retryAt: expect.any(String),
          },
        ],
      });
      const outbox = await call(outboxRoute.GET, { token: 'reader', params: { id } });
      expect(outbox.json.outbox).toMatchObject([{ state: 'PENDING', attempts: 1 }]);

      // The user reconnects; the retry falls due; the dispatcher job sends it.
      await db.platformConnection.update({ where: { id: conn.id }, data: { state: 'active' } });
      await db.autoPublishOutbox.updateMany({
        where: { projectId: id },
        data: { nextAttemptAt: new Date(Date.now() - 1_000) },
      });
      await j.h.queue.add('dispatch-auto-publish', {
        organisationId: 'postmind-platform',
        runId: 'aa03',
        planTier: 'STANDARD',
      });
      await drain(j);
      const sent = await call(outboxRoute.GET, { token: 'reader', params: { id } });
      expect(sent.json.outbox).toMatchObject([{ state: 'SENT', attempts: 2 }]);
      expect((await getProject(j, id)).state).toBe('PUBLISHED');
      expect(j.h.publishers.tiktok.published).toHaveLength(1);
      const meta = (await db.videoProject.findUniqueOrThrow({ where: { id } })).metadata as {
        autoPublishResult?: { status: string };
      };
      expect(meta.autoPublishResult?.status).toBe('created');
    });

    it('AA-04 an org cap override pauses generation; the rollover resumes it', async () => {
      const j = journey('aa04');
      const logger = pino({ level: 'silent' });
      const notifier = createNotifier({ db, logger, sender: { send: async () => undefined } });
      j.h.deps.budget = createPrismaBudgetChecker(db, {
        guard: createCostGuard({
          db,
          caps: costCapsFromEnv({}),
          notifier,
          audit: (entry) => j.h.audits.push(entry),
          logger,
          metrics: getMetrics(),
          overrides: createOrgCapOverrideLookup(db, { ttlMs: 0 }),
        }),
      });
      j.h.deps.notifier = notifier;
      await db.orgCostCap.create({
        data: {
          organisationId: j.org,
          dailyPence: 1,
          reason: 'Test: pause at once',
          updatedByUserId: 'staff-1',
        },
      });
      // Any spend today reaches a 1p cap.
      await db.providerUsage.create({
        data: {
          organisationId: j.org,
          provider: 'seed-earlier',
          day: utcDay(new Date()),
          jobCount: 1,
          costPence: 5,
        },
      });
      const id = await createProject(j);
      const paused = await generate(j, id, { expectClean: false });
      expect(paused.state).toBe('FAILED');
      expect(paused.errorReason).toMatch(/^cost_cap_paused: organisation daily cost cap/);
      const meta = (await db.videoProject.findUniqueOrThrow({ where: { id } })).metadata as {
        costPause?: { scope: string; job: string };
      };
      expect(meta.costPause).toMatchObject({ scope: 'org_daily', job: 'plan-project' });

      // Staff raise the override; the next day's rollover picks the project up.
      await db.orgCostCap.update({
        where: { organisationId: j.org },
        data: { dailyPence: 100_000 },
      });
      const sameDay = await resumeCostPausedProjects({ ...j.h.deps, now: () => Date.now() });
      expect(sameDay.items.find((i) => i.projectId === id)).toMatchObject({ action: 'skipped' });
      const nextDay = await resumeCostPausedProjects({
        ...j.h.deps,
        now: () => Date.now() + DAY_MS,
      });
      expect(nextDay.items.find((i) => i.projectId === id)).toMatchObject({
        action: 'resumed',
        stage: 'planning',
      });
      await drain(j);
      expect((await getProject(j, id)).state).toBe('READY_FOR_REVIEW');
    });
  },
);
