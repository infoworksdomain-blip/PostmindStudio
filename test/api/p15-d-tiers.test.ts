import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as adminUsageRoute from '../../src/app/api/studio/admin/organisations/[id]/usage/route';
import * as scanRoute from '../../src/app/api/studio/businesses/[id]/scan-website/route';
import * as generateImageRoute from '../../src/app/api/studio/image-library/generate/route';
import * as overlayPresetsRoute from '../../src/app/api/studio/overlay-presets/route';
import * as generateRoute from '../../src/app/api/studio/projects/[id]/generate/route';
import * as projectsRoute from '../../src/app/api/studio/projects/route';
import * as publicationsRoute from '../../src/app/api/studio/publications/route';
import * as slideshowTemplatesRoute from '../../src/app/api/studio/slideshow-templates/route';
import * as usageRoute from '../../src/app/api/studio/usage/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import type { TenantContext } from '../../src/lib/tenant';
import { call, installApi, tenant } from '../helpers/api-harness';

// BACKLOG 15.D2 (A10.3 tier gates, A10.4 caps) and decision P3 (spec 12.4 plan quotas): one API
// case per gate, the usage endpoints (auth, staff-only, tenant isolation) and warn vs enforce on
// generate and publish.

const hasDb = Boolean(process.env.DATABASE_URL);
const ADMIN_CAPS = ['studio:admin:providers'];

function onTier(organisationId: string, planTier: string, caps?: string[]): TenantContext {
  const t = tenant(organisationId, caps);
  return { ...t, organisation: { id: organisationId, planTier } };
}

describe.skipIf(!hasDb)('tier gates and plan quotas API (15.D2, P3)', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-tier-${randomUUID()}`;
  const other = `api-tier-other-${randomUUID()}`;
  const staffOrg = `api-tier-staff-${randomUUID()}`;
  const tokens = {
    basic: onTier(org, 'BASIC'),
    standard: onTier(org, 'STANDARD'),
    plus: onTier(org, 'PLUS'),
    other: onTier(other, 'BASIC'),
    staff: onTier(staffOrg, 'ENTERPRISE', ADMIN_CAPS),
    outsider: onTier(org, 'BASIC', ADMIN_CAPS),
  };
  const formats = [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 20 }];

  beforeEach(() => {
    installApi(db, tokens);
    vi.stubEnv('STUDIO_PLATFORM_ORG_IDS', staffOrg);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    setApiDeps(undefined);
    const orgs = [org, other];
    const ids = (
      await db.videoProject.findMany({
        where: { organisationId: { in: orgs } },
        select: { id: true },
      })
    ).map((p) => p.id);
    await db.videoRender.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.websiteScan.deleteMany({ where: { organisationId: { in: orgs } } });
    await db.imageLibraryItem.deleteMany({ where: { organisationId: { in: orgs } } });
    await db.notification.deleteMany({ where: { organisationId: { in: orgs } } });
    await db.$disconnect();
  });

  async function project(organisationId: string, generatedAt: Date | null, seconds = 20) {
    return db.videoProject.create({
      data: {
        organisationId,
        businessId: 'biz',
        createdByUserId: 'user-1',
        name: 'Quota',
        state: 'DRAFT',
        sourceType: 'BRIEF',
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: seconds }],
        metadata: generatedAt
          ? { runId: 'r', generationStart: { runId: 'r', at: generatedAt.toISOString() } }
          : {},
      },
    });
  }

  const expectPlanTier = (res: { status: number; json: Record<string, unknown> }, tier: string) => {
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ error: 'plan_tier', details: { requiredTier: tier } });
  };

  describe('A10.3 gates', () => {
    const libraryBody = (mode: 'INSPIRE' | 'TEMPLATE') => ({
      name: 'From library',
      businessId: 'biz',
      sourceType: 'LIBRARY_REFERENCE',
      referenceVideoId: 'lib-video-1',
      referenceMode: mode,
      brief: { rawInput: 'Our sourdough' },
      targetFormats: formats,
    });

    it('library INSPIRE needs Standard', async () => {
      const res = await call(projectsRoute.POST, {
        method: 'POST',
        token: 'basic',
        body: libraryBody('INSPIRE'),
      });
      expectPlanTier(res, 'STANDARD');
    });

    it('library TEMPLATE needs Plus', async () => {
      const res = await call(projectsRoute.POST, {
        method: 'POST',
        token: 'standard',
        body: libraryBody('TEMPLATE'),
      });
      expectPlanTier(res, 'PLUS');
      // Past the gate on Plus: the (unknown) reference video is the next check.
      const plus = await call(projectsRoute.POST, {
        method: 'POST',
        token: 'plus',
        body: libraryBody('TEMPLATE'),
      });
      expect(plus.status).toBe(400);
    });

    it('custom overlay presets need Standard', async () => {
      const res = await call(overlayPresetsRoute.POST, {
        method: 'POST',
        token: 'basic',
        body: {
          name: 'Our hook',
          group: 'hook',
          scope: 'org',
          parameters: { fontFamily: 'Anton', fillColor: '#FFCC00', fontSizePct: 8 },
        },
      });
      expectPlanTier(res, 'STANDARD');
    });

    it('custom slideshow templates need Standard', async () => {
      const res = await call(slideshowTemplatesRoute.POST, {
        method: 'POST',
        token: 'basic',
        body: { projectId: 'nope', name: 'My list', category: 'listicle' },
      });
      expectPlanTier(res, 'STANDARD');
    });

    it('website scans: one business on Basic, rescans allowed', async () => {
      await db.websiteScan.create({
        data: {
          organisationId: org,
          businessId: 'biz-a',
          url: 'https://example.com/',
          state: 'SUCCEEDED',
        },
      });
      const res = await call(scanRoute.POST, {
        method: 'POST',
        token: 'basic',
        params: { id: 'biz-b' },
        body: {
          url: 'https://example.org',
          ownershipConfirmed: true,
          ownershipStatement: 'I own or am authorised to represent this website',
        },
      });
      expectPlanTier(res, 'STANDARD');
      expect(res.json).toMatchObject({ details: { limit: 1, scannedBusinesses: 1 } });
    });

    it('image generation needs Plus, then the monthly cap per business applies', async () => {
      const body = { businessId: 'biz-img', prompt: 'a loaf on a table', aspectRatio: '1:1' };
      const std = await call(generateImageRoute.POST, { method: 'POST', token: 'standard', body });
      expectPlanTier(std, 'PLUS');
      vi.stubEnv('STUDIO_IMAGE_GEN_MONTHLY_CAP_PLUS', '1');
      await db.imageLibraryItem.create({
        data: {
          organisationId: org,
          businessId: 'biz-img',
          source: 'GENERATED',
          s3Bucket: 'assets',
          s3Key: `k-${randomUUID()}`,
          widthPx: 10,
          heightPx: 10,
          fileSizeBytes: 10,
          tags: [],
          fingerprint: randomUUID(),
        },
      });
      const capped = await call(generateImageRoute.POST, { method: 'POST', token: 'plus', body });
      expect(capped.status).toBe(403);
      expect(capped.json).toMatchObject({
        error: 'quota_exceeded',
        details: { quota: 'image_generation', used: 1, cap: 1 },
      });
    });
  });

  describe('GET /usage and the staff view', () => {
    it('401 without a token; counts only this organisation', async () => {
      expect((await call(usageRoute.GET, {})).status).toBe(401);
      await project(other, new Date());
      const res = await call(usageRoute.GET, { token: 'basic', path: '/api/studio/usage' });
      expect(res.status).toBe(200);
      const usage = res.json.usage as Record<string, unknown>;
      expect(usage).toMatchObject({
        organisationId: org,
        planTier: 'BASIC',
        mode: 'warn',
        thresholds: [80, 100],
        videos: { short: { limit: 20 }, long: { limit: 0 } },
        platforms: { description: 'TikTok + Instagram + 1 more' },
      });
      const otherRes = await call(usageRoute.GET, { token: 'other' });
      expect(
        (otherRes.json.usage as { videos: { short: { used: number } } }).videos.short.used,
      ).toBe(1);
    });

    it('includes the business image allowance with ?businessId', async () => {
      const res = await call(usageRoute.GET, {
        token: 'plus',
        path: '/api/studio/usage?businessId=biz-img',
      });
      expect(res.json.usage).toMatchObject({ imageGeneration: { businessId: 'biz-img' } });
    });

    it('admin usage is staff-only and validates the tier', async () => {
      const path = `/api/studio/admin/organisations/${org}/usage`;
      expect((await call(adminUsageRoute.GET, { path, params: { id: org } })).status).toBe(401);
      expect(
        (await call(adminUsageRoute.GET, { path, params: { id: org }, token: 'outsider' })).status,
      ).toBe(403);
      expect(
        (await call(adminUsageRoute.GET, { path, params: { id: org }, token: 'basic' })).status,
      ).toBe(403);
      const res = await call(adminUsageRoute.GET, {
        path: `${path}?tier=plus`,
        params: { id: org },
        token: 'staff',
      });
      expect(res.status).toBe(200);
      expect(res.json.usage).toMatchObject({
        organisationId: org,
        planTier: 'PLUS',
        tier: { value: 'PLUS', source: 'query' },
      });
      const bad = await call(adminUsageRoute.GET, {
        path: `${path}?tier=gold`,
        params: { id: org },
        token: 'staff',
      });
      expect(bad.status).toBe(400);
    });
  });

  describe('quota on generate and publish', () => {
    it('warn: generates and alerts once at 80 %; enforce: 403 quota_exceeded', async () => {
      // 16 of Basic's 20 short videos this month; the 17th crosses 80 %.
      for (let i = 0; i < 15; i += 1) await project(org, new Date());
      const next = await project(org, null);
      const warn = await call(generateRoute.POST, {
        method: 'POST',
        token: 'basic',
        params: { id: next.id },
        body: {},
      });
      expect(warn.status).toBe(202);
      const alerts = await db.notification.findMany({
        where: { organisationId: org, kind: 'plan_quota' },
      });
      expect(alerts.map((a) => a.dedupeKey)).toEqual([
        expect.stringMatching(/^plan-quota:\d{4}-\d{2}:short:80$/),
      ]);

      for (let i = 0; i < 4; i += 1) await project(org, new Date());
      vi.stubEnv('STUDIO_QUOTA_MODE', 'enforce');
      const blocked = await project(org, null);
      const res = await call(generateRoute.POST, {
        method: 'POST',
        token: 'basic',
        params: { id: blocked.id },
        body: {},
      });
      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({
        error: 'quota_exceeded',
        details: { mode: 'enforce', violations: [{ code: 'short_quota' }] },
      });
      expect(String(res.json.message)).toMatch(/Upgrade to Standard/);
    });

    it('enforce: Basic cannot publish to a second extra platform', async () => {
      vi.stubEnv('STUDIO_QUOTA_MODE', 'enforce');
      const p = await db.videoProject.create({
        data: {
          organisationId: org,
          businessId: 'biz',
          createdByUserId: 'user-1',
          name: 'Two extras',
          state: 'APPROVED',
          sourceType: 'BRIEF',
          targetFormats: [{ platform: 'x', aspectRatio: '9:16', duration: 15 }],
        },
      });
      const render = await db.videoRender.create({
        data: {
          projectId: p.id,
          scriptId: 'script-1',
          targetPlatform: 'x',
          aspectRatio: '9:16',
          resolution: '1080x1920',
          durationSec: 15,
          fps: 30,
          bitrateKbps: 4500,
          s3Bucket: 'renders',
          s3Key: `k-${randomUUID()}`,
          qualityCheckState: 'PASSED',
        },
      });
      const res = await call(publicationsRoute.POST, {
        method: 'POST',
        token: 'basic',
        body: { renderId: render.id, platform: 'linkedin_video' },
      });
      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({
        error: 'quota_exceeded',
        details: { violations: [{ code: 'platforms' }] },
      });
    });
  });
});
