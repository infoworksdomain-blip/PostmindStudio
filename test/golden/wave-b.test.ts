import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as listRoute from '../../src/app/api/studio/notifications/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { CoreEmailSender } from '../../src/lib/studio/notifications/email';
import { createNotifier } from '../../src/lib/studio/notifications/notifier';
import { call, installApi, tenant } from '../helpers/api-harness';

// Wave B journeys on real Postgres.
// WB-01 (13.33): a user who enabled email for "publication failed" gets the in-app notification;
// with Core selected as the email provider but no Core email API yet, the row records
// emailStatus pending_setup and GET /notifications returns it. A user who did not opt in gets no
// email status at all.

const hasDb = Boolean(process.env.DATABASE_URL);

type Item = { id: string; kind: string; emailStatus: string | null };

describe.skipIf(!hasDb)('Wave B golden journeys', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `golden-wave-b-${randomUUID()}`;
  const tokens = {
    alice: tenant(org, ['studio:project:read'], 'alice'),
    bob: tenant(org, ['studio:project:read'], 'bob'),
  };

  beforeEach(async () => {
    installApi(db, tokens);
    await db.notification.deleteMany({ where: { organisationId: org } });
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.notification.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  it('WB-01: opted-in email is recorded as pending setup and shown to the user', async () => {
    const notifier = createNotifier({
      db,
      logger: pino({ level: 'silent' }),
      sender: { send: async () => undefined },
      email: new CoreEmailSender(),
      emailPreferences: {
        // Alice enabled email for publication_failed; Bob did not.
        emailRecipients: async ({ userId, kind }) =>
          userId === 'alice' && kind === 'publication_failed' ? ['alice'] : [],
      },
    });

    const forAlice = await notifier.notify({
      organisationId: org,
      userId: 'alice',
      kind: 'publication_failed',
      title: 'Publishing “Launch” to tiktok failed',
      body: 'Open the project to retry.',
      link: '/projects/p1',
    });
    const forBob = await notifier.notify({
      organisationId: org,
      userId: 'bob',
      kind: 'publication_failed',
      title: 'Publishing “Launch” to x failed',
      body: 'Open the project to retry.',
    });
    expect(forAlice.emailStatus).toBe('pending_setup');
    expect(forBob.emailStatus).toBeUndefined();

    const stored = await db.notification.findMany({
      where: { organisationId: org },
      select: { userId: true, emailStatus: true },
      orderBy: { userId: 'asc' },
    });
    expect(stored).toEqual([
      { userId: 'alice', emailStatus: 'pending_setup' },
      { userId: 'bob', emailStatus: null },
    ]);

    const alice = await call(listRoute.GET, { path: '/api/studio/notifications', token: 'alice' });
    expect(alice.status).toBe(200);
    expect((alice.json.data as Item[]).map((n) => n.emailStatus)).toEqual(['pending_setup']);
    const bob = await call(listRoute.GET, { path: '/api/studio/notifications', token: 'bob' });
    expect((bob.json.data as Item[]).map((n) => n.emailStatus)).toEqual([null]);
  });
});
