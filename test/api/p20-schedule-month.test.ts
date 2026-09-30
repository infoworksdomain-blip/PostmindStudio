import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as upcomingRoute from '../../src/app/api/studio/businesses/[id]/drip-queue/upcoming/route';
import * as dripRoute from '../../src/app/api/studio/businesses/[id]/drip-queue/route';
import * as approveRoute from '../../src/app/api/studio/projects/[id]/approve/route';
import * as autoPublishRoute from '../../src/app/api/studio/projects/[id]/auto-publish/route';
import * as retryRoute from '../../src/app/api/studio/projects/[id]/auto-publish/retry/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { sealTokens } from '../../src/lib/studio/platforms/tokens';
import { upcomingSlots } from '../../src/lib/studio/services/drip-queue';
import { call, installApi, tenant } from '../helpers/api-harness';
import { createHarness } from '../helpers/pipeline-harness';

// 20.3 — month-ahead scheduling through the real routes on Postgres: the upcoming-slots view
// (window cap, capability, tenant scope, open vs held slots, scheduled count) and honest
// auto-scheduling (a SCHEDULED project with no slot is recorded, audited, notified, and can be
// scheduled again once posting times exist).

const hasDb = Boolean(process.env.DATABASE_URL);
const DAY = 86_400_000;

describe.skipIf(!hasDb)('20.3 month-ahead scheduling API', { timeout: 90_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-p20-${randomUUID()}`;
  const tokens = {
    owner: tenant(org),
    reader: tenant(org, ['studio:project:read']),
    none: tenant(org, []),
    stranger: tenant(`api-p20-other-${randomUUID()}`),
  };
  let h: ReturnType<typeof createHarness>;
  let api: ReturnType<typeof installApi>;

  beforeEach(() => {
    h = createHarness(db);
    api = installApi(db, tokens, {
      queue: h.queue,
      publishing: h.deps.publishing,
      pipeline: h.deps,
    });
  });

  afterAll(async () => {
    setApiDeps(undefined);
    const ids = (
      await db.videoProject.findMany({ where: { organisationId: org }, select: { id: true } })
    ).map((p) => p.id);
    const pubs = await db.videoPublication.findMany({
      where: { projectId: { in: ids } },
      select: { id: true },
    });
    await db.scheduledPublication.deleteMany({
      where: { publicationId: { in: pubs.map((p) => p.id) } },
    });
    await db.videoPublication.deleteMany({ where: { projectId: { in: ids } } });
    await db.autoPublishOutbox.deleteMany({ where: { organisationId: org } });
    await db.approvalTask.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoRender.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.platformConnection.deleteMany({ where: { organisationId: org } });
    await db.dripQueue.deleteMany({ where: { organisationId: org } });
    await db.notification.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  const newBiz = () => `biz-${randomUUID().slice(0, 8)}`;
  const upcoming = (biz: string, token = 'owner', query = '') =>
    call(upcomingRoute.GET, {
      token,
      params: { id: biz },
      path: `/api/studio/businesses/${biz}/drip-queue/upcoming${query}`,
    });
  const putQueue = (biz: string, body: unknown) =>
    call(dripRoute.PUT, { method: 'PUT', token: 'owner', params: { id: biz }, body });
  const daily = (time = '12:30') =>
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, time, timezone: 'Europe/London' }));

  async function connection(biz: string) {
    const sealed = await sealTokens(h.keys, org, 'tiktok', {
      accessToken: 'tt-access',
      refreshToken: 'tt-refresh',
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ['publish'],
    });
    return db.platformConnection.create({
      data: {
        organisationId: org,
        businessId: biz,
        platform: 'tiktok',
        platformAccountId: `tt-${randomUUID()}`,
        platformAccountName: 'Leeds Sourdough',
        ...sealed,
        scopes: ['publish'],
        state: 'active',
        connectedByUserId: 'user-1',
      },
    });
  }

  /** A READY_FOR_REVIEW SCHEDULED project (no start time) with a passed TikTok render. */
  async function scheduledProject(biz: string, connectionId: string) {
    const project = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId: biz,
        createdByUserId: 'user-1',
        name: 'Friday sourdough',
        state: 'READY_FOR_REVIEW',
        sourceType: 'BRIEF',
        publishPolicy: 'SCHEDULED',
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 15 }],
        metadata: { runId: randomUUID() },
      },
    });
    const key = `orgs/${org}/renders/${randomUUID()}.mp4`;
    await h.deps.storage.put({
      bucket: 'renders',
      key,
      body: new Uint8Array(2048),
      contentType: 'video/mp4',
    });
    const render = await db.videoRender.create({
      data: {
        projectId: project.id,
        scriptId: 'script-tiktok',
        targetPlatform: 'tiktok',
        aspectRatio: '9:16',
        resolution: '1080x1920',
        durationSec: 15,
        fps: 30,
        bitrateKbps: 4500,
        s3Bucket: 'renders',
        s3Key: key,
        qualityCheckState: 'PASSED',
      },
    });
    await db.videoProject.update({
      where: { id: project.id },
      data: {
        metadata: {
          runId: (project.metadata as { runId: string }).runId,
          renders: { 'script-tiktok': render.id },
          autoPublish: { targets: [{ platform: 'tiktok', connectionId, caption: 'Friday!' }] },
        } as Prisma.InputJsonValue,
      },
    });
    return project;
  }

  const approve = (id: string) =>
    call(approveRoute.POST, { method: 'POST', token: 'owner', params: { id }, body: {} });
  const issueOf = async (id: string) =>
    ((await db.videoProject.findUnique({ where: { id } }))?.metadata as Record<string, unknown>)
      .scheduleIssue as { reason: string; horizonDays: number } | undefined;

  it('upcoming: auth, capability, window cap and tenant scope', async () => {
    const biz = newBiz();
    expect((await call(upcomingRoute.GET, { params: { id: biz } })).status).toBe(401);
    expect((await upcoming(biz, 'none')).status).toBe(403);
    const from = new Date(Date.now() + DAY).toISOString();
    const to63 = new Date(Date.now() + 64 * DAY).toISOString();
    const wide = await upcoming(biz, 'reader', `?from=${from}&to=${to63}`);
    expect(wide.status).toBe(400);
    expect((await upcoming(biz, 'reader', '?from=yesterday')).status).toBe(400);
    expect((await upcoming(biz, 'reader', `?from=${from}&to=${from}`)).status).toBe(400);

    // No queue yet: honest empty answer.
    const none = await upcoming(biz, 'reader');
    expect(none.status).toBe(200);
    expect(none.json.upcoming).toMatchObject({
      configured: false,
      enabled: false,
      openSlots: [],
      scheduled: 0,
      horizonDays: 56,
    });
    expect((await putQueue(biz, { slots: daily() })).status).toBe(200);
    const got = (await upcoming(biz, 'reader')).json.upcoming as {
      enabled: boolean;
      slotsPerWeek: number;
      openSlots: string[];
      from: string;
      to: string;
    };
    expect(got.enabled).toBe(true);
    expect(got.slotsPerWeek).toBe(7);
    // Default window: 31 days, one slot a day.
    expect(Date.parse(got.to) - Date.parse(got.from)).toBe(31 * DAY);
    expect(got.openSlots.length).toBeGreaterThanOrEqual(30);
    expect(got.openSlots.length).toBeLessThanOrEqual(32);
    // Another organisation using the same business id sees nothing of it.
    const other = (await upcoming(biz, 'stranger')).json.upcoming as { configured: boolean };
    expect(other.configured).toBe(false);
  });

  it('upcoming: held slots are not open, and scheduled posts of the business are counted', async () => {
    const biz = newBiz();
    const conn = await connection(biz);
    expect((await putQueue(biz, { slots: daily() })).status).toBe(200);
    // One fixed window for both reads, so only the approval changes the answer.
    const t0 = Date.now();
    const window = `?from=${new Date(t0).toISOString()}&to=${new Date(t0 + 20 * DAY).toISOString()}`;
    const before = (await upcoming(biz, 'owner', window)).json.upcoming as { openSlots: string[] };
    const project = await scheduledProject(biz, conn.id);
    const approved = await approve(project.id);
    expect(approved.status).toBe(200);
    const scheduled = approved.json.scheduled as Array<{ scheduledFor: string }>;
    expect(scheduled).toHaveLength(1);
    const after = (await upcoming(biz, 'owner', window)).json.upcoming as {
      openSlots: string[];
      held: Array<{ slotAt: string; projectId: string }>;
      scheduled: number;
    };
    expect(after.held).toEqual([{ slotAt: scheduled[0]?.scheduledFor, projectId: project.id }]);
    expect(after.openSlots).not.toContain(scheduled[0]?.scheduledFor);
    expect(after.openSlots.length).toBe(before.openSlots.length - 1);
    expect(after.scheduled).toBe(1);
    // A publication of another business does not count here.
    const elsewhere = (await upcoming(newBiz())).json.upcoming as { scheduled: number };
    expect(elsewhere.scheduled).toBe(0);
  });

  it('a SCHEDULED project with the queue off is surfaced, then scheduled on "Try again"', async () => {
    const biz = newBiz();
    const conn = await connection(biz);
    const project = await scheduledProject(biz, conn.id);
    const res = await approve(project.id);
    expect(res.status).toBe(200);
    expect(res.json.scheduled).toEqual([]);
    expect(await issueOf(project.id)).toMatchObject({ reason: 'queue_off', horizonDays: 56 });
    expect(api.audits.find((a) => a.action === 'studio.project.schedule_unassigned')).toMatchObject(
      {
        organisationId: org,
        resource: { type: 'video_project', id: project.id },
        metadata: { reason: 'queue_off', horizonDays: 56 },
      },
    );
    const notice = await db.notification.findFirst({
      where: { organisationId: org, messageKey: 'scheduleQueueOff' },
    });
    expect(notice).toMatchObject({
      userId: 'user-1',
      kind: 'auto_publish_failed',
      link: `/projects/${project.id}`,
    });
    const view = await call(autoPublishRoute.GET, { token: 'reader', params: { id: project.id } });
    expect(view.json.scheduleIssue).toMatchObject({ reason: 'queue_off' });

    // Still off: "Try again" says so and writes nothing.
    const still = await call(retryRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: project.id },
      body: {},
    });
    expect(still.status).toBe(202);
    expect(still.json).toMatchObject({ requeued: 0, scheduled: 0, unscheduled: 'queue_off' });

    // Posting times set: the retry takes the next free slot and clears the notice.
    expect((await putQueue(biz, { slots: daily() })).status).toBe(200);
    const retried = await call(retryRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: project.id },
      body: {},
    });
    expect(retried.json).toMatchObject({ requeued: 0, scheduled: 1, unscheduled: null });
    expect(await issueOf(project.id)).toBeUndefined();
    const pubs = await db.videoPublication.findMany({ where: { projectId: project.id } });
    expect(pubs.map((p) => p.state)).toEqual(['SCHEDULED']);
    expect((pubs[0]?.scheduledFor?.getTime() ?? 0) - Date.now()).toBeLessThanOrEqual(2 * DAY);
    // Nothing left to plan: another retry is a no-op.
    const again = await call(retryRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: project.id },
      body: {},
    });
    expect(again.json).toMatchObject({ scheduled: 0, unscheduled: null });
  });

  it('reports a queue for other platforms, and a queue full for the whole horizon', async () => {
    const biz = newBiz();
    const conn = await connection(biz);
    expect((await putQueue(biz, { slots: daily(), platforms: ['youtube_short'] })).status).toBe(
      200,
    );
    const wrong = await scheduledProject(biz, conn.id);
    await approve(wrong.id);
    expect(await issueOf(wrong.id)).toMatchObject({ reason: 'no_matching_platform' });

    // One weekly slot, every instance within the horizon already held by another video.
    const monday = [{ weekday: 1, time: '08:30', timezone: 'Europe/London' }];
    expect((await putQueue(biz, { slots: monday, platforms: [] })).status).toBe(200);
    const holder = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId: biz,
        createdByUserId: 'user-1',
        state: 'APPROVED',
        sourceType: 'BRIEF',
        targetFormats: [],
      },
    });
    const slots = upcomingSlots(monday, Date.now());
    await db.autoPublishOutbox.createMany({
      data: slots.map((at, i) => ({
        organisationId: org,
        projectId: holder.id,
        approvalTaskId: `held-${holder.id}-${i}`,
        targetIndex: 0,
        target: { platform: 'tiktok' },
        planTier: 'STANDARD',
        trigger: 'human',
        state: 'SENT' as const,
        slotAt: new Date(at),
        scheduledFor: new Date(at),
      })),
    });
    const full = await scheduledProject(biz, conn.id);
    const res = await approve(full.id);
    expect(res.json.scheduled).toEqual([]);
    expect(await issueOf(full.id)).toMatchObject({ reason: 'no_free_slot', horizonDays: 56 });
    const notice = await db.notification.findFirst({
      where: { organisationId: org, messageKey: 'scheduleNoFreeSlot' },
    });
    expect(notice?.body).toContain('next 8 weeks');
    expect(notice?.messageParams).toMatchObject({ name: 'Friday sourdough', weeks: 8 });
    // The month-ahead view agrees: no open slot left.
    const view = (await upcoming(biz)).json.upcoming as { openSlots: string[] };
    expect(view.openSlots).toEqual([]);
  });
});
