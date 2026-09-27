import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as readRoute from '../../src/app/api/studio/notifications/[id]/read/route';
import * as readAllRoute from '../../src/app/api/studio/notifications/read-all/route';
import * as listRoute from '../../src/app/api/studio/notifications/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import {
  APPROVAL_PENDING_AFTER_MS,
  notifyGenerationComplete,
  notifyPendingApprovals,
  notifyPublicationFailed,
} from '../../src/lib/studio/notifications/events';
import { createNotifier } from '../../src/lib/studio/notifications/notifier';
import type { OutboundNotification } from '../../src/lib/studio/notifications/sender';
import { call, installApi, tenant } from '../helpers/api-harness';

// Spec 14.4: GET /notifications (own + organisation-wide, unread filter, cursor), POST
// /notifications/:id/read, POST /notifications/read-all; and the event hooks that write them
// (generation complete, publication failed, approval pending > 2 h) on real Postgres.

const hasDb = Boolean(process.env.DATABASE_URL);

type Item = { id: string; kind: string; title: string; readAt: string | null; link: string | null };

describe.skipIf(!hasDb)('notifications API + events', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-notif-${randomUUID()}`;
  const otherOrg = `api-notif-other-${randomUUID()}`;
  const tokens = {
    alice: tenant(org, ['studio:project:read'], 'alice'),
    bob: tenant(org, ['studio:project:read'], 'bob'),
    mallory: tenant(otherOrg, ['studio:project:read'], 'mallory'),
    noCaps: tenant(org, [], 'alice'),
  };
  const sent: OutboundNotification[] = [];
  const logger = pino({ level: 'silent' });
  const notifier = createNotifier({ db, logger, sender: { send: async (n) => void sent.push(n) } });

  const cleanup = () =>
    db.notification.deleteMany({ where: { organisationId: { in: [org, otherOrg] } } });

  beforeEach(async () => {
    installApi(db, tokens);
    sent.length = 0;
    await cleanup();
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await cleanup();
    await db.videoPublication.deleteMany({ where: { organisationId: org } });
    await db.videoRender.deleteMany({ where: { project: { organisationId: org } } });
    await db.videoScript.deleteMany({ where: { project: { organisationId: org } } });
    await db.videoProject.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  const list = async (token: string, path = '/api/studio/notifications') => {
    const res = await call(listRoute.GET, { token, path });
    return res as typeof res & {
      json: { data: Item[]; unreadCount: number; nextCursor: string | null };
    };
  };

  it('lists own + organisation-wide notifications only, newest first, with the unread count', async () => {
    await notifier.notify({
      organisationId: org,
      userId: 'alice',
      kind: 'cost_alert',
      title: 'for alice',
      body: 'b',
    });
    await notifier.notify({
      organisationId: org,
      userId: 'bob',
      kind: 'cost_alert',
      title: 'for bob',
      body: 'b',
    });
    await notifier.notify({
      organisationId: org,
      kind: 'approval_pending',
      title: 'for everyone',
      body: 'b',
    });
    await notifier.notify({
      organisationId: otherOrg,
      kind: 'cost_alert',
      title: 'other org',
      body: 'b',
    });

    const alice = await list('alice');
    expect(alice.status).toBe(200);
    expect(alice.json.data.map((n) => n.title)).toEqual(['for everyone', 'for alice']);
    expect(alice.json.unreadCount).toBe(2);
    expect((await list('mallory')).json.data.map((n) => n.title)).toEqual(['other org']);
    expect((await list('noCaps')).status).toBe(403);
  });

  it('pages with a cursor and filters unread / read', async () => {
    for (let i = 0; i < 5; i += 1) {
      await notifier.notify({
        organisationId: org,
        userId: 'alice',
        kind: 'cost_alert',
        title: `n${i}`,
        body: 'b',
      });
    }
    const first = await list('alice', '/api/studio/notifications?limit=2');
    expect(first.json.data).toHaveLength(2);
    const second = await list(
      'alice',
      `/api/studio/notifications?limit=2&cursor=${first.json.nextCursor}`,
    );
    const third = await list(
      'alice',
      `/api/studio/notifications?limit=2&cursor=${second.json.nextCursor}`,
    );
    const titles = [...first.json.data, ...second.json.data, ...third.json.data].map(
      (n) => n.title,
    );
    expect(new Set(titles).size).toBe(5);
    expect(third.json.nextCursor).toBeNull();

    const target = first.json.data[0]!;
    const read = await call(readRoute.POST, {
      method: 'POST',
      token: 'alice',
      params: { id: target.id },
    });
    expect(read.status).toBe(200);
    expect((read.json.notification as Item).readAt).not.toBeNull();
    // Idempotent.
    expect(
      (await call(readRoute.POST, { method: 'POST', token: 'alice', params: { id: target.id } }))
        .status,
    ).toBe(200);

    expect((await list('alice', '/api/studio/notifications?unread=true')).json.data).toHaveLength(
      4,
    );
    expect(
      (await list('alice', '/api/studio/notifications?unread=false')).json.data.map((n) => n.id),
    ).toEqual([target.id]);
    expect((await list('alice', '/api/studio/notifications?unread=maybe')).status).toBe(400);
  });

  it('cannot read another user’s or organisation’s notification (404)', async () => {
    const { id } = await notifier.notify({
      organisationId: org,
      userId: 'bob',
      kind: 'cost_alert',
      title: 'bob',
      body: 'b',
    });
    for (const token of ['alice', 'mallory']) {
      const res = await call(readRoute.POST, { method: 'POST', token, params: { id: id! } });
      expect(res.status).toBe(404);
    }
    expect((await db.notification.findUniqueOrThrow({ where: { id: id! } })).readAt).toBeNull();
  });

  it('read-all marks only what the caller can see', async () => {
    await notifier.notify({
      organisationId: org,
      userId: 'alice',
      kind: 'cost_alert',
      title: 'a',
      body: 'b',
    });
    await notifier.notify({ organisationId: org, kind: 'cost_alert', title: 'all', body: 'b' });
    await notifier.notify({
      organisationId: org,
      userId: 'bob',
      kind: 'cost_alert',
      title: 'bob',
      body: 'b',
    });
    const res = await call(readAllRoute.POST, { method: 'POST', token: 'alice' });
    expect(res.json).toMatchObject({ ok: true, updated: 2 });
    expect((await list('alice')).json.unreadCount).toBe(0);
    expect((await list('bob')).json.unreadCount).toBe(1);
  });

  describe('event hooks', () => {
    async function project(
      state: 'READY_FOR_REVIEW' | 'APPROVED',
      completedAt: Date | null = null,
    ) {
      const runId = randomUUID();
      const p = await db.videoProject.create({
        data: {
          organisationId: org,
          businessId: 'biz',
          createdByUserId: 'alice',
          name: 'Sourdough launch',
          state,
          sourceType: 'BRIEF',
          targetFormats: [],
          completedAt,
          metadata: { runId },
        },
      });
      return { project: p, runId };
    }
    const host = (now = Date.now()) => ({ db, logger, notifier, now: () => now });

    it('generation complete: one notification per run, worded by state', async () => {
      const { project: p, runId } = await project('READY_FOR_REVIEW');
      const input = { projectId: p.id, organisationId: org, runId };
      await notifyGenerationComplete(host(), input);
      await notifyGenerationComplete(host(), input);
      const auto = await project('APPROVED');
      await notifyGenerationComplete(host(), {
        projectId: auto.project.id,
        organisationId: org,
        runId: auto.runId,
      });
      const items = (await list('alice')).json.data;
      expect(items.map((n) => n.title)).toEqual([
        '“Sourdough launch” is generated and was auto-approved',
        '“Sourdough launch” is ready for review',
      ]);
      expect(items[1]).toMatchObject({ kind: 'generation_complete', link: `/projects/${p.id}` });
      // Wrong organisation: nothing, and no throw.
      await notifyGenerationComplete(host(), { ...input, organisationId: otherOrg });
      expect((await list('mallory')).json.data).toHaveLength(0);
    });

    it('publication failed: tells the creator once per failure, with the retry link', async () => {
      const { project: p } = await project('APPROVED');
      const script = await db.videoScript.create({
        data: {
          projectId: p.id,
          targetPlatform: 'tiktok',
          targetAspectRatio: '9:16',
          targetDurationSec: 15,
          fullText: 's',
          scriptModel: 'test',
        },
      });
      const render = await db.videoRender.create({
        data: {
          projectId: p.id,
          scriptId: script.id,
          targetPlatform: 'tiktok',
          aspectRatio: '9:16',
          resolution: '1080x1920',
          durationSec: 15,
          fps: 30,
          bitrateKbps: 4500,
          s3Bucket: 'b',
          s3Key: 'k',
          qualityCheckState: 'PASSED',
        },
      });
      const pub = await db.videoPublication.create({
        data: {
          organisationId: org,
          projectId: p.id,
          renderId: render.id,
          platform: 'tiktok',
          platformAccountId: 'acct',
          state: 'FAILED',
          retryCount: 1,
        },
      });
      const failure = {
        publicationId: pub.id,
        organisationId: org,
        projectId: p.id,
        reason: 'tiktok/rate_limited: slow down',
      };
      await notifyPublicationFailed(host(), failure);
      await notifyPublicationFailed(host(), failure);
      await db.videoPublication.update({ where: { id: pub.id }, data: { retryCount: 2 } });
      await notifyPublicationFailed(host(), failure);
      const items = (await list('alice')).json.data.filter((n) => n.kind === 'publication_failed');
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({
        title: 'Publishing “Sourdough launch” to tiktok failed',
        link: `/projects/${p.id}`,
      });
      expect(sent.some((s) => s.kind === 'publication_failed')).toBe(true);
    });

    it('approval pending > 2 h: org-wide, once per run, not before 2 h or after 7 days', async () => {
      const now = Date.now();
      const due = await project(
        'READY_FOR_REVIEW',
        new Date(now - APPROVAL_PENDING_AFTER_MS - 60_000),
      );
      await project('READY_FOR_REVIEW', new Date(now - 30 * 60_000));
      await project('READY_FOR_REVIEW', new Date(now - 8 * 24 * 60 * 60_000));
      const first = await notifyPendingApprovals(host(now));
      expect(first.notified).toBeGreaterThanOrEqual(1);
      await notifyPendingApprovals(host(now));
      const items = (await list('bob')).json.data.filter((n) => n.kind === 'approval_pending');
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        title: '“Sourdough launch” is waiting for approval',
        link: `/projects/${due.project.id}`,
      });
    });
  });
});
