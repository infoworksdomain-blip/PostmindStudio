import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as transparencyRoute from '../../src/app/api/studio/admin/transparency/route';
import * as takedownsRoute from '../../src/app/api/studio/admin/takedown-requests/route';
import * as takedownRoute from '../../src/app/api/studio/admin/takedown-requests/[id]/route';
import * as retentionRoute from '../../src/app/api/studio/admin/retention/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import type { AuditEntry } from '../../src/lib/audit';
import type { CoreOrganisationDirectory } from '../../src/lib/studio/core/organisation-directory';
import type { PipelineDeps } from '../../src/lib/studio/pipeline/deps';
import {
  reconcileOrganisationsJob,
  reportUsage,
} from '../../src/lib/studio/queue/workers/core-sync';
import { deriveCalendarShadows } from '../../src/lib/studio/services/calendar-shadows';
import { reconcileOrganisations } from '../../src/lib/studio/services/organisation-reconciliation';
import { purgeBusiness } from '../../src/lib/studio/services/business-purge';
import { runRetentionSweep } from '../../src/lib/studio/services/retention';
import { deriveUsageEvents } from '../../src/lib/studio/services/usage-events';
import { flagKeys } from '../../src/lib/studio/system-flags';
import { call, installApi, tenant } from '../helpers/api-harness';
import { memoryStorage } from '../helpers/memory-storage';

// Phase 15 track E staff APIs and background jobs: 15.E4 transparency + takedown log, 15.E8
// retention preview + sweep (incl. 15.E2 business hard delete), 15.W2 usage outbox, 15.W3
// calendar shadows, 15.W4 organisation reconciliation.

const hasDb = Boolean(process.env.DATABASE_URL);
const DAY = 86_400_000;
const STAFF = `p15e-staff-${randomUUID()}`;
const logger = pino({ level: 'silent' });

describe.skipIf(!hasDb)('track E admin APIs and jobs', { timeout: 90_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `p15e-adm-${randomUUID()}`;
  const gone = `p15e-gone-${randomUUID()}`;
  let api: ReturnType<typeof installApi>;
  const takedownIds: string[] = [];

  const project = (
    data: {
      organisationId?: string;
      businessId?: string;
      deletedAt?: Date;
      errorReason?: string;
    } = {},
  ) =>
    db.videoProject.create({
      data: {
        organisationId: data.organisationId ?? org,
        businessId: data.businessId ?? 'biz',
        createdByUserId: 'user-1',
        name: 'P',
        state: 'FAILED',
        sourceType: 'BRIEF',
        targetFormats: [],
        deletedAt: data.deletedAt ?? null,
        errorReason: data.errorReason ?? null,
      },
    });
  const render = (projectId: string, key = `r/${randomUUID()}.mp4`) =>
    db.videoRender.create({
      data: {
        projectId,
        scriptId: 's',
        targetPlatform: 'tiktok',
        aspectRatio: '9:16',
        resolution: '1080x1920',
        durationSec: 15,
        fps: 30,
        bitrateKbps: 4000,
        s3Bucket: 'renders',
        s3Key: key,
        qualityCheckState: 'PASSED',
      },
    });

  beforeEach(() => {
    vi.stubEnv('STUDIO_PLATFORM_ORG_IDS', STAFF);
    api = installApi(db, {
      staff: tenant(STAFF, ['studio:admin:moderation'], 'staff-1'),
      customer: tenant(org, ['studio:admin:moderation']),
      noCap: tenant(STAFF, ['studio:project:read']),
    });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    setApiDeps(undefined);
    const orgs = { in: [org, gone] };
    const ids = (await db.videoProject.findMany({ where: { organisationId: orgs } })).map(
      (p) => p.id,
    );
    const pubs = (await db.videoPublication.findMany({ where: { projectId: { in: ids } } })).map(
      (p) => p.id,
    );
    await db.calendarShadow.deleteMany({ where: { organisationId: orgs } });
    await db.usageEvent.deleteMany({ where: { organisationId: orgs } });
    await db.videoPublication.deleteMany({ where: { id: { in: pubs } } });
    await db.videoAsset.deleteMany({ where: { organisationId: orgs } });
    await db.videoRender.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.providerJob.deleteMany({ where: { organisationId: orgs } });
    await db.providerUsage.deleteMany({ where: { organisationId: orgs } });
    await db.brandKit.deleteMany({ where: { organisationId: orgs } });
    await db.platformConnection.deleteMany({ where: { organisationId: orgs } });
    await db.businessPurge.deleteMany({ where: { organisationId: orgs } });
    await db.organisationPurge.deleteMany({ where: { organisationId: orgs } });
    await db.systemFlag.deleteMany({
      where: { key: { in: [flagKeys.workspace(gone), ...ids.map(flagKeys.project)] } },
    });
    await db.takedownRequest.deleteMany({ where: { id: { in: takedownIds } } });
    await db.$disconnect();
  });

  describe('transparency + takedown log (15.E4)', () => {
    it('is staff-only, logs and resolves requests, and counts the year', async () => {
      const year = 2031;
      expect(
        (await call(transparencyRoute.GET, { path: `/x?year=${year}`, token: 'customer' })).status,
      ).toBe(403);
      expect(
        (await call(transparencyRoute.GET, { path: `/x?year=${year}`, token: 'noCap' })).status,
      ).toBe(403);
      const post = (body: Record<string, unknown>) =>
        call(takedownsRoute.POST, { method: 'POST', body, token: 'staff' });
      expect(
        (
          await post({
            receivedAt: '2031-02-01T00:00:00Z',
            source: 'fax',
            category: 'copyright',
            summary: 's',
          })
        ).status,
      ).toBe(400);
      const a = await post({
        receivedAt: '2031-02-01T00:00:00Z',
        source: 'policy_mailbox',
        category: 'copyright',
        summary: 'Song used',
      });
      const b = await post({
        receivedAt: '2031-03-01T00:00:00Z',
        source: 'platform',
        category: 'safety',
        summary: 'TikTok notice',
      });
      expect(a.status).toBe(201);
      const id = (a.json.request as { id: string }).id;
      takedownIds.push(id, (b.json.request as { id: string }).id);
      expect(api.audits.at(-1)).toMatchObject({
        action: 'studio.takedown_request.create',
        actorUserId: 'staff-1',
      });
      const resolve = (body: Record<string, unknown>) =>
        call(takedownRoute.PATCH, { method: 'PATCH', params: { id }, body, token: 'staff' });
      expect((await resolve({ state: 'ACTIONED', resolutionNote: 'Removed' })).status).toBe(200);
      expect((await resolve({ state: 'REJECTED', resolutionNote: 'x' })).status).toBe(409);
      const list = await call(takedownsRoute.GET, { path: `/x?year=${year}`, token: 'staff' });
      expect((list.json.data as unknown[]).length).toBe(2);
      const report = await call(transparencyRoute.GET, { path: `/x?year=${year}`, token: 'staff' });
      expect(report.json.report).toMatchObject({
        year,
        takedownRequests: { total: 1, bySource: { policy_mailbox: 1 }, byOutcome: { ACTIONED: 1 } },
        platformMandatedRemovals: { total: 1, byCategory: { safety: 1 } },
      });
      expect((await call(transparencyRoute.GET, { path: '/x', token: 'staff' })).status).toBe(400);
    });
  });

  describe('retention (15.E8) and business hard delete (15.E2)', () => {
    it('previews for staff only, then sweeps each spec 7.15 rule', async () => {
      const now = Date.now();
      const oldDeleted = await project({ deletedAt: new Date(now - 100 * DAY) });
      const recentDeleted = await project({ deletedAt: new Date(now - 5 * DAY) });
      const published = await render(oldDeleted.id);
      await db.videoPublication.create({
        data: {
          organisationId: org,
          projectId: oldDeleted.id,
          renderId: published.id,
          platform: 'tiktok',
          platformAccountId: 'a',
          state: 'PUBLISHED',
        },
      });
      const unpublished = await render(oldDeleted.id);
      const keepRender = await render(recentDeleted.id);
      const asset = await db.videoAsset.create({
        data: {
          organisationId: org,
          projectId: oldDeleted.id,
          kind: 'IMAGE',
          source: 't',
          s3Bucket: 'assets',
          s3Key: `a/${randomUUID()}.png`,
        },
      });
      const oldJob = await db.providerJob.create({
        data: {
          organisationId: org,
          provider: 'runway',
          operation: 'x',
          requestBody: {},
          state: 'SUCCEEDED',
          startedAt: new Date(now - 61 * DAY),
        },
      });
      const newJob = await db.providerJob.create({
        data: {
          organisationId: org,
          provider: 'runway',
          operation: 'x',
          requestBody: {},
          state: 'SUCCEEDED',
          startedAt: new Date(now - DAY),
        },
      });

      expect((await call(retentionRoute.GET, { token: 'customer' })).status).toBe(403);
      const preview = await call(retentionRoute.GET, { token: 'staff' });
      expect(preview.json.dryRun).toBe(true);
      const due = Object.fromEntries(
        (preview.json.rules as Array<{ rule: string; due: number }>).map((r) => [r.rule, r.due]),
      );
      expect(due.video_renders).toBeGreaterThanOrEqual(1);
      expect(due.provider_jobs).toBeGreaterThanOrEqual(1);
      expect(await db.videoRender.count({ where: { id: unpublished.id } })).toBe(1); // preview deleted nothing

      // A purged business whose grace has passed is hard-deleted by the same sweep.
      const bizGone = `gone-biz-${randomUUID()}`;
      const bizProject = await project({ businessId: bizGone });
      await render(bizProject.id, 'r/biz.mp4');
      await db.brandKit.create({
        data: {
          organisationId: org,
          businessId: bizGone,
          name: 'K',
          colourPalette: [],
          toneKeywords: [],
          ctaTemplates: [],
          restrictedTopics: [],
        },
      });
      await purgeBusiness(
        { db, now: () => now - 31 * DAY },
        { organisationId: org, businessId: bizGone },
      );

      const { storage, objects } = memoryStorage();
      for (const key of [unpublished.s3Key, published.s3Key, keepRender.s3Key, 'r/biz.mp4'])
        await storage.put({
          bucket: 'renders',
          key,
          body: new Uint8Array([1]),
          contentType: 'video/mp4',
        });
      await storage.put({
        bucket: 'assets',
        key: asset.s3Key,
        body: new Uint8Array([1]),
        contentType: 'image/png',
      });
      const audits: AuditEntry[] = [];
      const result = await runRetentionSweep({
        db,
        storage,
        logger,
        audit: (e) => audits.push(e),
        now: () => now,
      });

      expect(await db.videoRender.findUnique({ where: { id: unpublished.id } })).toBeNull();
      expect(objects.has(`renders/${unpublished.s3Key}`)).toBe(false);
      expect(await db.videoRender.findUnique({ where: { id: published.id } })).not.toBeNull();
      expect(objects.has(`renders/${published.s3Key}`)).toBe(true);
      expect(await db.videoRender.findUnique({ where: { id: keepRender.id } })).not.toBeNull();
      expect(await db.videoAsset.findUnique({ where: { id: asset.id } })).toBeNull();
      expect(objects.has(`assets/${asset.s3Key}`)).toBe(false);
      expect(await db.providerJob.findUnique({ where: { id: oldJob.id } })).toBeNull();
      expect(await db.providerJob.findUnique({ where: { id: newJob.id } })).not.toBeNull();
      expect(result.business_purges.rows).toBeGreaterThan(0);
      expect(await db.videoProject.findUnique({ where: { id: bizProject.id } })).toBeNull();
      expect(await db.brandKit.count({ where: { organisationId: org, businessId: bizGone } })).toBe(
        0,
      );
      expect(objects.has('renders/r/biz.mp4')).toBe(false);
      expect(
        await db.businessPurge.findFirst({ where: { organisationId: org, businessId: bizGone } }),
      ).toMatchObject({ state: 'hard_deleted' });
      expect(audits).toContainEqual(
        expect.objectContaining({ action: 'studio.business.hard_delete' }),
      );
    });
  });

  describe('Core sync outboxes (15.W2 / 15.W3 / 15.W4)', () => {
    it('derives usage events idempotently and keeps them pending_setup', async () => {
      const p = await project();
      const r = await render(p.id);
      await db.providerJob.create({
        data: {
          organisationId: org,
          projectId: p.id,
          provider: 'runway',
          operation: 'x',
          requestBody: {},
          state: 'SUCCEEDED',
          costPence: 42,
          completedAt: new Date(),
        },
      });
      const first = await deriveUsageEvents(db, Date.now());
      expect(first.inserted).toBeGreaterThanOrEqual(2);
      const again = await deriveUsageEvents(db, Date.now());
      expect(again.inserted).toBe(0);
      const ev = await db.usageEvent.findUniqueOrThrow({ where: { eventKey: `render:${r.id}` } });
      expect(ev).toMatchObject({
        organisationId: org,
        eventType: 'video_generated',
        state: 'pending_setup',
      });
      const deps = { db, logger, now: Date.now } as unknown as PipelineDeps;
      await reportUsage(
        { organisationId: 'postmind-platform', runId: 'u', planTier: 'STANDARD' },
        deps,
      );
      expect((await db.usageEvent.findUniqueOrThrow({ where: { id: ev.id } })).state).toBe(
        'pending_setup',
      );
    });

    it('mirrors schedule, reschedule and cancel into calendar shadows', async () => {
      const p = await project();
      const r = await render(p.id);
      const pub = await db.videoPublication.create({
        data: {
          organisationId: org,
          projectId: p.id,
          renderId: r.id,
          platform: 'tiktok',
          platformAccountId: 'a',
          state: 'SCHEDULED',
          scheduledFor: new Date(Date.now() + DAY),
        },
      });
      await deriveCalendarShadows(db, Date.now());
      expect(
        await db.calendarShadow.findUniqueOrThrow({ where: { publicationId: pub.id } }),
      ).toMatchObject({ desiredOp: 'upsert', state: 'pending_setup' });
      expect((await deriveCalendarShadows(db, Date.now())).armed).toBe(0);
      const moved = new Date(Date.now() + 2 * DAY);
      await db.videoPublication.update({ where: { id: pub.id }, data: { scheduledFor: moved } });
      await deriveCalendarShadows(db, Date.now());
      expect(
        (
          await db.calendarShadow.findUniqueOrThrow({ where: { publicationId: pub.id } })
        ).scheduledFor?.getTime(),
      ).toBe(moved.getTime());
      await db.videoPublication.update({ where: { id: pub.id }, data: { state: 'CANCELLED' } });
      await deriveCalendarShadows(db, Date.now());
      expect(
        await db.calendarShadow.findUniqueOrThrow({ where: { publicationId: pub.id } }),
      ).toMatchObject({ desiredOp: 'delete', scheduledFor: null });
    });

    it('reconciles organisations Core no longer has, with a mass-deletion safety valve; skips while pending', async () => {
      await project({ organisationId: gone });
      await project();
      const deps = { db, logger, audit: vi.fn(), now: Date.now };
      // Pending directory: the nightly job is skipped and purges nothing.
      await reconcileOrganisationsJob(
        { organisationId: 'p', runId: 'r', planTier: 'STANDARD' },
        deps as unknown as PipelineDeps,
      );
      expect(await db.organisationPurge.findUnique({ where: { organisationId: gone } })).toBeNull();
      // Everything missing → refused (more than 20 % of more than 5 organisations).
      const none: CoreOrganisationDirectory = { ready: true, existing: async () => new Set() };
      const total = (
        await db.videoProject.findMany({ where: { deletedAt: null }, distinct: ['organisationId'] })
      ).length;
      if (total > 5)
        await expect(
          reconcileOrganisations({ ...deps, directory: none }, { apply: true }),
        ).rejects.toThrow(/refusing/);
      // Only `gone` missing → purged with the 30-day grace; dry run first reports without applying.
      const allButGone: CoreOrganisationDirectory = {
        ready: true,
        existing: async (ids) => new Set(ids.filter((id) => id !== gone)),
      };
      const dry = await reconcileOrganisations(
        { ...deps, directory: allButGone },
        { apply: false },
      );
      expect(dry).toMatchObject({ missing: [gone], applied: false });
      const report = await reconcileOrganisations(
        { ...deps, directory: allButGone },
        { apply: true },
      );
      expect(report.purged).toMatchObject([{ organisationId: gone, projectsDeleted: 1 }]);
      expect(deps.audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'studio.organisation.purge', organisationId: gone }),
      );
      expect(
        (await reconcileOrganisations({ ...deps, directory: allButGone }, { apply: true })).missing,
      ).toEqual([]);
    });
  });
});
