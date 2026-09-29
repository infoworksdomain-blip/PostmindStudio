import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as notificationsRoute from '../../src/app/api/studio/notifications/route';
import * as prefsRoute from '../../src/app/api/studio/notification-preferences/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { createNotifier } from '../../src/lib/studio/notifications/notifier';
import { createPreferenceLookup } from '../../src/lib/studio/notifications/preferences';
import { call, installApi, tenant } from '../helpers/api-harness';

// BACKLOG 13.24 — GET|PATCH /notification-preferences (own preferences, per kind), email stored
// but "pending setup", and the preferences respected by the notifier and GET /notifications.

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('notification preferences API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-prefs-${randomUUID()}`;
  const tokens = {
    amara: tenant(org, ['studio:project:read'], 'amara'),
    ben: tenant(org, ['studio:project:read'], 'ben'),
  };
  let api: ReturnType<typeof installApi>;

  beforeAll(() => {
    api = installApi(db, tokens);
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.notificationPreference.deleteMany({ where: { organisationId: org } });
    await db.notification.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  it('GET returns defaults for every kind and the email delivery state', async () => {
    const res = await call(prefsRoute.GET, { token: 'amara' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      // Phase 18 §2.8: standalone mode sends email through Resend (test/api/p18-email.test.ts
      // covers "suppressed" and the core-mode "pending_setup").
      emailDelivery: 'active',
      preferences: {
        generation_complete: { inApp: true, email: false },
        milestone: { inApp: true, email: false },
        safety_review: { inApp: true, email: false },
      },
    });
    expect((await call(prefsRoute.GET, {})).status).toBe(401);
  });

  it('PATCH changes only the caller’s preferences and is audited', async () => {
    const res = await call(prefsRoute.PATCH, {
      method: 'PATCH',
      token: 'amara',
      body: { milestone: { inApp: false }, publication_failed: { email: true } },
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      preferences: {
        milestone: { inApp: false, email: false },
        publication_failed: { inApp: true, email: true },
      },
    });
    const ben = await call(prefsRoute.GET, { token: 'ben' });
    expect(ben.json).toMatchObject({ preferences: { milestone: { inApp: true } } });
    expect(
      api.audits.find((a) => a.action === 'studio.notification_preferences.update'),
    ).toMatchObject({
      actorUserId: 'amara',
      metadata: { kinds: ['milestone', 'publication_failed'] },
    });
    for (const body of [{}, { newsletter: { email: true } }, { milestone: { sms: true } }]) {
      const bad = await call(prefsRoute.PATCH, { method: 'PATCH', token: 'amara', body });
      expect(bad.status).toBe(400);
    }
  });

  it('the notifier and the notification list respect in-app preferences', async () => {
    const preferences = createPreferenceLookup(db);
    const notifier = createNotifier({
      db,
      logger: pino({ level: 'silent' }),
      sender: { send: async () => undefined },
      email: null,
      preferences,
      emailPreferences: preferences,
    });
    const milestone = {
      organisationId: org,
      kind: 'milestone' as const,
      title: 'Reached 10,000 views',
      body: 'Nice',
    };
    // Amara turned milestones off in-app: her own is not stored; Ben's is.
    expect(
      (await notifier.notify({ ...milestone, userId: 'amara', dedupeKey: 'm-a' })).created,
    ).toBe(false);
    expect((await notifier.notify({ ...milestone, userId: 'ben', dedupeKey: 'm-b' })).created).toBe(
      true,
    );
    // Organisation-wide: stored once, hidden from Amara's list only.
    expect(
      (await notifier.notify({ ...milestone, userId: null, dedupeKey: 'm-org' })).created,
    ).toBe(true);
    // Amara opted in to email for publication failures: stored with email pending setup.
    const failed = await notifier.notify({
      organisationId: org,
      userId: 'amara',
      kind: 'publication_failed',
      title: 'Publishing failed',
      body: 'x',
      dedupeKey: 'pf-a',
    });
    expect(failed).toMatchObject({ created: true, emailStatus: 'pending_setup' });

    const amara = await call(notificationsRoute.GET, { token: 'amara' });
    const kinds = (amara.json.data as Array<{ kind: string }>).map((n) => n.kind);
    expect(kinds).toEqual(['publication_failed']);
    expect(amara.json.unreadCount).toBe(1);
    const ben = await call(notificationsRoute.GET, { token: 'ben' });
    expect(
      (ben.json.data as Array<{ kind: string }>).filter((n) => n.kind === 'milestone'),
    ).toHaveLength(2);
  });
});
