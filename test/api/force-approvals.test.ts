import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as forceApprovalsRoute from '../../src/app/api/studio/admin/force-approvals/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { call, installApi, tenant } from '../helpers/api-harness';
import { createProject } from '../helpers/pipeline-harness';

// BACKLOG 15.D5 — GET /admin/force-approvals (spec 13.5): staff-only review of renders whose
// quality gate a customer overrode.

const hasDb = Boolean(process.env.DATABASE_URL);
const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!hasDb)('admin force-approvals API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const staffOrg = `api-fa-staff-${randomUUID()}`;
  const org = `api-fa-org-${randomUUID()}`;
  const tokens = {
    staff: tenant(staffOrg, ['studio:admin:moderation']),
    staffNoCaps: tenant(staffOrg, ['studio:admin:providers']),
    outsider: tenant(org, ['studio:admin:moderation']),
  };

  beforeEach(() => {
    installApi(db, tokens);
    vi.stubEnv('STUDIO_PLATFORM_ORG_IDS', staffOrg);
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    setApiDeps(undefined);
    await db.videoRender.deleteMany({ where: { project: { organisationId: org } } });
    await db.videoProject.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  const render = (projectId: string, state: 'FORCE_APPROVED' | 'PASSED', issues: unknown[]) =>
    db.videoRender.create({
      data: {
        projectId,
        scriptId: 'script-1',
        targetPlatform: 'tiktok',
        aspectRatio: '9:16',
        resolution: '1080x1920',
        durationSec: 10,
        fps: 30,
        bitrateKbps: 4000,
        s3Bucket: 'renders',
        s3Key: `orgs/${org}/${randomUUID()}.mp4`,
        qualityCheckState: state,
        qualityIssues: issues as never,
      },
    });

  it('lists force-approved renders in the window with note, user, failed checks and project', async () => {
    const { project } = await createProject(db, { organisationId: org });
    const failed = { code: 'loudness', status: 'failed', severity: 'error', detail: '-24 LUFS' };
    const recent = await render(project.id, 'FORCE_APPROVED', [
      failed,
      {
        code: 'force_approved',
        status: 'passed',
        severity: 'info',
        detail: 'by user-7: comedy sketch',
        userId: 'user-7',
        note: 'comedy sketch',
        at: new Date(Date.now() - DAY).toISOString(),
      },
    ]);
    const old = await render(project.id, 'FORCE_APPROVED', [
      failed,
      {
        code: 'force_approved',
        status: 'passed',
        severity: 'info',
        detail: 'by user-7: long ago',
        userId: 'user-7',
        note: 'long ago',
        at: new Date(Date.now() - 40 * DAY).toISOString(),
      },
    ]);
    await render(project.id, 'PASSED', []);

    const res = await call(forceApprovalsRoute.GET, {
      token: 'staff',
      path: `/api/studio/admin/force-approvals?days=30&organisationId=${org}`,
    });
    expect(res.status).toBe(200);
    const items = res.json.items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.renderId)).toEqual([recent.id]);
    expect(items[0]).toMatchObject({
      approvedByUserId: 'user-7',
      note: 'comedy sketch',
      approvedAtRecorded: true,
      failedChecks: [{ code: 'loudness', severity: 'error', detail: '-24 LUFS' }],
      project: { id: project.id, name: 'Leeds Sourdough Co' },
      organisationId: org,
    });

    const wider = await call(forceApprovalsRoute.GET, {
      token: 'staff',
      path: `/api/studio/admin/force-approvals?days=90&organisationId=${org}`,
    });
    expect((wider.json.items as Array<{ renderId: string }>).map((i) => i.renderId)).toEqual([
      recent.id,
      old.id,
    ]);
  });

  it('validates days and refuses non-staff or callers without moderation', async () => {
    const path = '/api/studio/admin/force-approvals?days=0';
    expect((await call(forceApprovalsRoute.GET, { token: 'staff', path })).status).toBe(400);
    expect((await call(forceApprovalsRoute.GET, { token: 'outsider' })).status).toBe(403);
    expect((await call(forceApprovalsRoute.GET, { token: 'staffNoCaps' })).status).toBe(403);
    expect((await call(forceApprovalsRoute.GET, {})).status).toBe(401);
  });
});
