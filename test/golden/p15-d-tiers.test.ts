import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as adminUsageRoute from '../../src/app/api/studio/admin/organisations/[id]/usage/route';
import * as overlayPresetsRoute from '../../src/app/api/studio/overlay-presets/route';
import * as generateRoute from '../../src/app/api/studio/projects/[id]/generate/route';
import * as projectsRoute from '../../src/app/api/studio/projects/route';
import * as slideshowTemplatesRoute from '../../src/app/api/studio/slideshow-templates/route';
import * as usageRoute from '../../src/app/api/studio/usage/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { seedSlideshowTemplates } from '../../src/lib/studio/slideshow/seed-templates';
import type { TenantContext } from '../../src/lib/tenant';
import { call, tenant } from '../helpers/api-harness';
import {
  BUSINESS_ID,
  briefBody,
  cleanupGolden,
  createProject,
  drain,
  getProject,
  ORG_PREFIX,
  startJourney,
} from './journey-kit';

// Phase 15 Track D — 15.D2 (A10.3 tier gates, A10.4 slideshow budget) and decision P3 (spec 12.4
// plan quotas), through the real routes and the inline pipeline:
//
//   GT-01  A Basic customer generates a video (the usage meter counts it), starts a slideshow
//          (the £1.50 A10.4 default budget), is refused the Standard features (custom preset,
//          library INSPIRE) with 403 plan_tier and gets them after upgrading. With a two-video
//          quota the second generation raises the 80 % and 100 % alerts once each; in enforce
//          mode the third is refused with 403 quota_exceeded, and staff see the same usage.

const hasDb = Boolean(process.env.DATABASE_URL);
const STAFF_ORG = `${ORG_PREFIX}-p15d-tiers-staff`;

function onTier(org: string, planTier: string, caps?: string[]): TenantContext {
  const t = tenant(org, caps);
  return { ...t, organisation: { id: org, planTier } };
}

describe.skipIf(!hasDb)('Phase 15 Track D tier journeys', { timeout: 180_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const since = new Date();

  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    setApiDeps(undefined);
    await db.notification.deleteMany({ where: { organisationId: { startsWith: ORG_PREFIX } } });
    await db.overlayPreset.deleteMany({ where: { organisationId: { startsWith: ORG_PREFIX } } });
    await cleanupGolden(db, since);
    await db.$disconnect();
  }, 120_000);

  it('GT-01 Basic plan: meter, gates, upgrade, alerts and enforcement', async () => {
    const org = `${ORG_PREFIX}-p15d-tiers`;
    vi.stubEnv('STUDIO_PLATFORM_ORG_IDS', STAFF_ORG);
    vi.stubEnv('STUDIO_QUOTA_BASIC_SHORT', '2');
    await seedSlideshowTemplates(db);
    const j = startJourney(
      db,
      'p15d-tiers',
      {},
      {
        owner: onTier(org, 'BASIC'),
        upgraded: onTier(org, 'STANDARD'),
        staff: onTier(STAFF_ORG, 'ENTERPRISE', ['studio:admin:providers']),
      },
    );
    const usage = async () =>
      (await call(usageRoute.GET, { token: 'owner' })).json.usage as {
        status: string;
        videos: { short: { used: number; limit: number } };
      };
    expect((await usage()).videos.short).toMatchObject({ used: 0, limit: 2 });

    // One video through the whole pipeline (generated while on Standard: the harness scripts the
    // Standard providers; the quota counts per organisation whatever the tier).
    const first = await createProject(j);
    const started = await call(generateRoute.POST, {
      method: 'POST',
      token: 'upgraded',
      params: { id: first },
      body: {},
    });
    expect(started.status).toBe(202);
    await drain(j);
    expect((await getProject(j, first)).state).toBe('READY_FOR_REVIEW');
    expect((await usage()).videos.short.used).toBe(1);

    // Slideshows are on every tier and default to the A10.4 £1.50 budget.
    const templates = (await call(slideshowTemplatesRoute.GET, { token: 'owner' })).json
      .data as Array<{ id: string; organisationId: string | null; category: string }>;
    const builtIn = templates.find((t) => t.organisationId === null && t.category === 'listicle_5');
    const slideshow = await call(projectsRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: {
        name: 'Five loaves',
        businessId: BUSINESS_ID,
        sourceType: 'SLIDESHOW',
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 15 }],
        slideshow: { templateId: builtIn?.id, topic: 'Five loaves we bake daily' },
      },
    });
    expect(slideshow.status).toBe(201);
    expect(slideshow.json.project).toMatchObject({ costBudgetPence: 150 });

    // Standard features are refused on Basic and available after the upgrade.
    const preset = {
      name: 'Our hook',
      group: 'hook',
      scope: 'org',
      parameters: { fontFamily: 'Anton', fillColor: '#FFCC00', fontSizePct: 8 },
    };
    const refused = await call(overlayPresetsRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: preset,
    });
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({
      error: 'plan_tier',
      details: { requiredTier: 'STANDARD' },
    });
    const inspire = await call(projectsRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: {
        ...briefBody(),
        sourceType: 'LIBRARY_REFERENCE',
        referenceVideoId: 'any',
        referenceMode: 'INSPIRE',
      },
    });
    expect(inspire.json).toMatchObject({
      error: 'plan_tier',
      details: { requiredTier: 'STANDARD' },
    });
    expect(
      (await call(overlayPresetsRoute.POST, { method: 'POST', token: 'upgraded', body: preset }))
        .status,
    ).toBe(201);

    // The second video reaches 100 % of the two-video quota: both alerts, once each.
    const second = await createProject(j);
    const warned = await call(generateRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: second },
      body: {},
    });
    expect(warned.status).toBe(202);
    const alerts = async () =>
      (
        await db.notification.findMany({
          where: { organisationId: org, kind: 'plan_quota' },
          orderBy: { createdAt: 'asc' },
        })
      ).map((n) => n.dedupeKey?.replace(/:\d{4}-\d{2}:/, ':<month>:'));
    expect(await alerts()).toEqual(['plan-quota:<month>:short:80', 'plan-quota:<month>:short:100']);
    expect((await usage()).status).toBe('exceeded');

    // Enforce mode: the third video is refused with an upgrade message; no duplicate alerts.
    vi.stubEnv('STUDIO_QUOTA_MODE', 'enforce');
    const third = await createProject(j);
    const blocked = await call(generateRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: third },
      body: {},
    });
    expect(blocked.status).toBe(403);
    expect(blocked.json).toMatchObject({ error: 'quota_exceeded' });
    expect(String(blocked.json.message)).toMatch(/Upgrade to Standard/);
    expect(await alerts()).toHaveLength(2);

    // Staff see the same numbers, at the tier recorded on the latest generation.
    const staff = await call(adminUsageRoute.GET, { token: 'staff', params: { id: org } });
    expect(staff.status).toBe(200);
    expect(staff.json.usage).toMatchObject({
      tier: { value: 'BASIC', source: 'last_generation' },
      mode: 'enforce',
      videos: { short: { used: 2, limit: 2 } },
    });
  });
});
