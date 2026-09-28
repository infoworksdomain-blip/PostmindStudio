import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as featuresRoute from '../../src/app/api/studio/admin/features/route';
import * as imageLibraryRoute from '../../src/app/api/studio/image-library/route';
import * as libraryVideosRoute from '../../src/app/api/studio/library/videos/route';
import * as overlayPresetsRoute from '../../src/app/api/studio/overlay-presets/route';
import * as projectsRoute from '../../src/app/api/studio/projects/route';
import * as slideshowTemplatesRoute from '../../src/app/api/studio/slideshow-templates/route';
import { FeatureDisabledError } from '../../src/lib/errors';
import { setApiDeps } from '../../src/lib/studio/api/context';
import type { PipelineDeps } from '../../src/lib/studio/pipeline/deps';
import { featureGateFor, featureKeys } from '../../src/lib/studio/services/features';
import { executeJob } from '../../src/lib/studio/queue/workers/runtime';
import { call, installApi, tenant } from '../helpers/api-harness';

// BACKLOG 15.D1 / Addendum A12.4 — "Any feature can be disabled per-org or globally within 60
// seconds via SystemFlag toggle". Per-organisation toggles are exercised end to end here; global
// toggles are only written as "enabled" (other suites share this database in parallel) and the
// global-off path is covered by the unit tests in services/features.test.ts.

const hasDb = Boolean(process.env.DATABASE_URL);
const ADMIN_CAPS = ['studio:admin:kill-switch:read', 'studio:admin:kill-switch:write'];

describe.skipIf(!hasDb)('feature flags API (15.D1)', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const staffOrg = `api-feat-staff-${randomUUID()}`;
  const org = `api-feat-${randomUUID()}`;
  const tokens = {
    staff: tenant(staffOrg, ADMIN_CAPS),
    outsider: tenant(org, ADMIN_CAPS),
    user: tenant(org),
  };
  let audits: ReturnType<typeof installApi>['audits'];

  beforeEach(() => {
    audits = installApi(db, tokens).audits;
    vi.stubEnv('STUDIO_PLATFORM_ORG_IDS', staffOrg);
    featureGateFor(db).invalidate();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.systemFlag.deleteMany({ where: { key: { contains: org } } });
    await db.$disconnect();
  });

  const put = (body: unknown, token = 'staff') =>
    call(featuresRoute.PUT, { method: 'PUT', token, body });

  it('is staff-only and validates the body', async () => {
    expect((await call(featuresRoute.GET, {})).status).toBe(401);
    expect((await call(featuresRoute.GET, { token: 'outsider' })).status).toBe(403);
    expect((await call(featuresRoute.GET, { token: 'user' })).status).toBe(403);
    const bad = [
      { feature: 'music', scope: 'global', enabled: false, reason: 'incident' },
      { feature: 'slideshow', scope: 'organisation', enabled: false, reason: 'incident' },
      { feature: 'slideshow', scope: 'global', enabled: false, reason: 'x' },
      { feature: 'slideshow', scope: 'global', enabled: false, reason: 'ok!', extra: 1 },
    ];
    for (const body of bad) expect((await put(body)).status).toBe(400);
    expect(
      (await put({ feature: 'slideshow', scope: 'global', enabled: true, reason: 'fine' }, 'user'))
        .status,
    ).toBe(403);
  });

  it('turns a feature off for one organisation only, with an audit entry', async () => {
    const res = await put({
      feature: 'library',
      scope: 'organisation',
      organisationId: org,
      enabled: false,
      reason: 'licence review',
    });
    expect(res.status).toBe(200);
    const features = res.json.features as Record<
      string,
      { global: boolean; disabledFor: string[] }
    >;
    expect(features.library?.disabledFor).toContain(org);
    expect(features.library?.global).toBe(true);
    expect(audits.at(-1)).toMatchObject({
      action: 'studio.feature.disable',
      resource: { type: 'system_flag', id: featureKeys.organisation('library', org) },
      metadata: { feature: 'library', scope: 'organisation', reason: 'licence review' },
    });

    const blocked = await call(libraryVideosRoute.GET, { token: 'user' });
    expect(blocked.status).toBe(403);
    expect(blocked.json).toMatchObject({
      ok: false,
      error: 'feature_disabled',
      details: { feature: 'library', scope: 'organisation' },
    });
    // Another organisation still browses (per-org scope).
    installApi(db, { ...tokens, other: tenant(`api-feat-other-${randomUUID()}`) });
    expect((await call(libraryVideosRoute.GET, { token: 'other' })).status).toBe(200);
  });

  it("disabling one feature doesn't break the others (A14.2)", async () => {
    await put({
      feature: 'slideshow',
      scope: 'organisation',
      organisationId: org,
      enabled: false,
      reason: 'incident',
    });
    expect((await call(slideshowTemplatesRoute.GET, { token: 'user' })).json.error).toBe(
      'feature_disabled',
    );
    expect((await call(overlayPresetsRoute.GET, { token: 'user' })).status).toBe(200);
    expect((await call(imageLibraryRoute.GET, { token: 'user' })).status).not.toBe(403);
    // Creating a SLIDESHOW project is refused; the check runs before any row is written.
    const create = await call(projectsRoute.POST, {
      method: 'POST',
      token: 'user',
      body: {
        name: 'Listicle',
        businessId: 'biz_1',
        sourceType: 'SLIDESHOW',
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 15 }],
        slideshow: { templateId: 'tpl', inputs: {} },
      },
    });
    expect([400, 403]).toContain(create.status);
    if (create.status === 403) expect(create.json.error).toBe('feature_disabled');
    expect(await db.videoProject.count({ where: { organisationId: org } })).toBe(0);
  });

  it('re-enabling removes the override; GET shows the state', async () => {
    const res = await put({
      feature: 'slideshow',
      scope: 'organisation',
      organisationId: org,
      enabled: true,
      reason: 'resolved',
    });
    expect(res.status).toBe(200);
    expect(audits.at(-1)?.action).toBe('studio.feature.enable');
    const state = await call(featuresRoute.GET, { token: 'staff' });
    const features = state.json.features as Record<string, { disabledFor: string[] }>;
    expect(features.slideshow?.disabledFor).not.toContain(org);
    expect(features.library?.disabledFor).toContain(org);
    expect(state.json.propagationSec).toBe(30);
    expect((await call(slideshowTemplatesRoute.GET, { token: 'user' })).status).toBe(200);
    // Writing a global "enabled" is harmless to parallel suites.
    expect(
      (await put({ feature: 'overlays', scope: 'global', enabled: true, reason: 'baseline' }))
        .status,
    ).toBe(200);
  });

  it("the feature's worker jobs stop with feature_disabled (not retried)", async () => {
    await put({
      feature: 'slideshow',
      scope: 'organisation',
      organisationId: org,
      enabled: false,
      reason: 'incident',
    });
    const deps = { db, logger: pino({ level: 'silent' }) } as unknown as PipelineDeps;
    const killSwitch = { assertNotKilled: vi.fn(async () => undefined) };
    await expect(
      executeJob(
        'populate-slideshow',
        { projectId: 'p1', organisationId: org, runId: 'r1', planTier: 'STANDARD' },
        { ...deps, killSwitch: { ...killSwitch, check: vi.fn(), invalidate: vi.fn() } },
        { attemptsMade: 0, maxAttempts: 1 },
      ),
    ).rejects.toThrow(/slideshow feature is currently disabled/);
    expect(new FeatureDisabledError('slideshow', 'x').status).toBe(403);
  });
});
