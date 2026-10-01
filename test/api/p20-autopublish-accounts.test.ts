import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as generateRoute from '../../src/app/api/studio/content-plans/[id]/generate/route';
import * as planRoute from '../../src/app/api/studio/content-plans/[id]/route';
import * as plansRoute from '../../src/app/api/studio/content-plans/route';
import * as approveRoute from '../../src/app/api/studio/projects/[id]/approve/route';
import * as projectsRoute from '../../src/app/api/studio/projects/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { sealTokens } from '../../src/lib/studio/platforms/tokens';
import { drainInline } from '../../src/lib/studio/queue/workers/runtime';
import { call, installApi, tenant } from '../helpers/api-harness';
import { createHarness } from '../helpers/pipeline-harness';

// 20.12 — auto-publish needs connected ACCOUNTS (not just platforms): the project API refuses
// auto-publish or a schedule with no account (translated code auto_publish_account_required)
// and an account that is not this organisation's (auto_publish_account_unavailable);
// slideshows auto-publish like videos (targets saved → outbox rows on approval); a month plan
// with no account is drafted and generated with every post saved for review, not scheduled.

const hasDb = Boolean(process.env.DATABASE_URL);
const HOUR = 3_600_000;

type Plan = {
  id: string;
  status: string;
  targets: unknown[];
  items: Array<{ id: string; status: string; projectId: string | null }>;
};

describe.skipIf(!hasDb)('20.12 auto-publish accounts API', { timeout: 180_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-p20-accounts-${randomUUID()}`;
  const otherOrg = `api-p20-accounts-other-${randomUUID()}`;
  const tokens = { owner: tenant(org) };
  let h: ReturnType<typeof createHarness>;
  let biz: string;
  let tiktokId: string;
  let foreignId: string;

  const connection = async (organisationId: string, businessId: string) => {
    const sealed = await sealTokens(h.keys, organisationId, 'tiktok', {
      accessToken: 'tt-access',
      refreshToken: 'tt-refresh',
      expiresAt: new Date(Date.now() + HOUR),
      scopes: ['publish'],
    });
    return (
      await db.platformConnection.create({
        data: {
          organisationId,
          businessId,
          platform: 'tiktok',
          platformAccountId: `tt-${randomUUID()}`,
          platformAccountName: 'Ahead TikTok',
          ...sealed,
          scopes: ['publish'],
          state: 'active',
          connectedByUserId: 'user-1',
        },
      })
    ).id;
  };

  beforeEach(async () => {
    h = createHarness(db);
    installApi(db, tokens, { queue: h.queue, publishing: h.deps.publishing, pipeline: h.deps });
    biz = `biz-${randomUUID().slice(0, 8)}`;
    tiktokId = await connection(org, biz);
    foreignId = await connection(otherOrg, 'biz-other');
  });

  afterAll(async () => {
    setApiDeps(undefined);
    const ids = (
      await db.videoProject.findMany({ where: { organisationId: org }, select: { id: true } })
    ).map((p) => p.id);
    await db.autoPublishOutbox.deleteMany({ where: { organisationId: org } });
    await db.approvalTask.deleteMany({ where: { projectId: { in: ids } } });
    await db.contentPlan.deleteMany({ where: { organisationId: org } });
    await db.slideshowSlide.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoPublication.deleteMany({ where: { organisationId: org } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.platformConnection.deleteMany({
      where: { organisationId: { in: [org, otherOrg] } },
    });
    await db.notification.deleteMany({ where: { organisationId: org } });
    await db.providerJob.deleteMany({ where: { organisationId: org } });
    await db.providerUsage.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  const brief = (extra: Record<string, unknown> = {}) => ({
    businessId: biz,
    sourceType: 'BRIEF',
    brief: { rawInput: 'AheadAi launch week' },
    targetFormats: [
      { platform: 'tiktok', aspectRatio: '9:16', durationSec: 30 },
      { platform: 'x', aspectRatio: '16:9', durationSec: 30 },
    ],
    ...extra,
  });
  const slideshow = (extra: Record<string, unknown> = {}) => ({
    businessId: biz,
    sourceType: 'SLIDESHOW',
    name: 'AheadAi in five slides',
    slideshow: {
      topic: 'AheadAi launch',
      slides: [
        { slideType: 'TEXT_CARD', content: { role: 'hook', text: 'Meet AheadAi' } },
        { slideType: 'TEXT_CARD', content: { role: 'body', text: 'Plans your week' } },
      ],
    },
    targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 15 }],
    ...extra,
  });
  const create = (body: unknown) =>
    call(projectsRoute.POST, { method: 'POST', token: 'owner', body });

  it('refuses auto-publish or a schedule without an account, with a translated code', async () => {
    const auto = await create(brief({ publishPolicy: 'AUTO_ON_APPROVAL' }));
    expect(auto.status).toBe(400);
    expect(auto.json).toMatchObject({ ok: false, error: 'auto_publish_account_required' });

    const scheduled = await create(
      brief({
        publishPolicy: 'SCHEDULED',
        scheduledStartAt: new Date(Date.now() + 48 * HOUR).toISOString(),
        autoPublish: { targets: [] },
      }),
    );
    expect(scheduled.status).toBe(400);
    expect(scheduled.json).toMatchObject({ error: 'auto_publish_account_required' });

    // The same rule for slideshows; nothing chosen (MANUAL) is fine without any account.
    expect((await create(slideshow({ publishPolicy: 'AUTO_ON_APPROVAL' }))).json).toMatchObject({
      error: 'auto_publish_account_required',
    });
    expect((await create(brief())).status).toBe(201);
    expect((await create(slideshow())).status).toBe(201);
  });

  it('refuses another organisation’s account with auto_publish_account_unavailable', async () => {
    const res = await create(
      brief({
        publishPolicy: 'AUTO_ON_APPROVAL',
        autoPublish: { targets: [{ platform: 'tiktok', connectionId: foreignId }] },
      }),
    );
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: 'auto_publish_account_unavailable' });
  });

  it('a slideshow auto-publishes like a video: targets saved, outbox rows on approval', async () => {
    const res = await create(
      slideshow({
        publishPolicy: 'AUTO_ON_APPROVAL',
        autoPublish: { targets: [{ platform: 'tiktok', connectionId: tiktokId }] },
      }),
    );
    expect(res.status).toBe(201);
    const id = (res.json.project as { id: string }).id;
    const stored = await db.videoProject.findUniqueOrThrow({ where: { id } });
    expect(stored.sourceType).toBe('SLIDESHOW');
    expect(stored.publishPolicy).toBe('AUTO_ON_APPROVAL');
    expect((stored.metadata as { autoPublish?: unknown }).autoPublish).toEqual({
      targets: [{ platform: 'tiktok', connectionId: tiktokId }],
    });

    // Approve it (as after rendering) through the real route: one outbox row for the target.
    await db.videoProject.update({ where: { id }, data: { state: 'READY_FOR_REVIEW' } });
    const approved = await call(approveRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id },
      body: {},
    });
    expect(approved.status).toBe(200);
    const rows = await db.autoPublishOutbox.findMany({ where: { projectId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ targetIndex: 0, trigger: 'human' });
    expect(rows[0]?.target).toMatchObject({ platform: 'tiktok', connectionId: tiktokId });
  });

  it('a slideshow can be scheduled for a time, like a video', async () => {
    const at = new Date(Date.now() + 72 * HOUR).toISOString();
    const res = await create(
      slideshow({
        publishPolicy: 'SCHEDULED',
        scheduledStartAt: at,
        autoPublish: { targets: [{ platform: 'tiktok', connectionId: tiktokId }] },
      }),
    );
    expect(res.status).toBe(201);
    const stored = await db.videoProject.findUniqueOrThrow({
      where: { id: (res.json.project as { id: string }).id },
    });
    expect(stored.publishPolicy).toBe('SCHEDULED');
    expect(stored.scheduledStartAt?.toISOString()).toBe(at);
  });

  const plan = (overrides: Record<string, unknown>) =>
    call(plansRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: {
        businessId: biz,
        days: 2,
        postsPerDay: 1,
        videoShare: 50,
        platforms: ['tiktok'],
        timezone: 'Europe/London',
        ...overrides,
      },
    });
  async function generated(overrides: Record<string, unknown>): Promise<Plan> {
    const res = await plan(overrides);
    expect(res.status, JSON.stringify(res.json)).toBe(202);
    await drainInline(h.queue, h.deps);
    const id = (res.json.plan as Plan).id;
    const drafted = await call(planRoute.GET, { token: 'owner', params: { id } });
    expect((drafted.json.plan as Plan).status).toBe('DRAFT');
    const run = await call(generateRoute.POST, { method: 'POST', token: 'owner', params: { id } });
    expect(run.status).toBe(202);
    return run.json.plan as Plan;
  }

  it('DECISION: a month plan with no account is generated, every post saved for review', async () => {
    const result = await generated({ targets: [] });
    expect(result.targets).toEqual([]);
    const ids = result.items.map((i) => i.projectId!);
    expect(ids.length).toBeGreaterThan(0);
    const projects = await db.videoProject.findMany({ where: { id: { in: ids } } });
    for (const p of projects) {
      expect(p.reviewPolicy).toBe('REQUIRE_APPROVAL');
      expect(p.publishPolicy).toBe('MANUAL');
      expect(p.scheduledStartAt).toBeNull();
      const meta = p.metadata as Record<string, unknown>;
      expect(meta.autoPublish).toBeUndefined();
      expect(meta.contentPlan).toMatchObject({ preApproved: false });
    }
  });

  it('a platform without an account is still made; the others are scheduled', async () => {
    const result = await generated({
      platforms: ['tiktok', 'youtube_short'],
      targets: [{ platform: 'tiktok', connectionId: tiktokId }],
    });
    const projects = await db.videoProject.findMany({
      where: { id: { in: result.items.map((i) => i.projectId!) } },
    });
    for (const p of projects) {
      expect(p.publishPolicy).toBe('SCHEDULED');
      expect(p.reviewPolicy).toBe('AUTO_APPROVE');
      expect((p.targetFormats as unknown[]).length).toBe(2);
      expect((p.metadata as { autoPublish: { targets: unknown[] } }).autoPublish.targets).toEqual([
        { platform: 'tiktok', connectionId: tiktokId },
      ]);
    }
  });

  it('a plan naming another organisation’s account is refused with the translated code', async () => {
    const res = await plan({ targets: [{ platform: 'tiktok', connectionId: foreignId }] });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: 'auto_publish_account_unavailable' });
  });
});
