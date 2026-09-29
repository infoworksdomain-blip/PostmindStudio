import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { UnrecoverableError } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as prefsRoute from '../../src/app/api/studio/notification-preferences/route';
import { createAuthMailer } from '../../src/lib/email/mailer';
import { createEmailOutbox } from '../../src/lib/email/outbox';
import type { EmailTransport, OutgoingEmail } from '../../src/lib/email/resend-client';
import { handleResendWebhook, handleUnsubscribe } from '../../src/lib/email/routes';
import { emailAddressHash, isSuppressed, suppressAddress } from '../../src/lib/email/suppression';
import { signSvix } from '../../src/lib/email/webhook';
import { ProviderError, ValidationError } from '../../src/lib/errors';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { createEmailSender } from '../../src/lib/studio/notifications/email';
import { createNotifier } from '../../src/lib/studio/notifications/notifier';
import { createPreferenceLookup } from '../../src/lib/studio/notifications/preference-lookup';
import {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from '../../src/lib/studio/notifications/unsubscribe';
import type { PipelineDeps } from '../../src/lib/studio/pipeline/deps';
import { InlineJobQueue } from '../../src/lib/studio/queue/enqueue';
import { executeJob } from '../../src/lib/studio/queue/workers/runtime';
import { sweepEmailOutbox } from '../../src/lib/studio/queue/workers/send-email';
import { APP_URL, call, installApi, tenant } from '../helpers/api-harness';

// Phase 18 Track B (plans/phase-18.md §2.8, §7 Track B tests) against a real database: outbox
// idempotency, suppression, the send-email job (success, retry, give-up), the sweeper, the Resend
// webhook (signature, bounce / complaint suppression), one-click unsubscribe, the notification
// email path (preferences → verified users → outbox) and the preferences dialog's delivery state.

const hasDb = Boolean(process.env.DATABASE_URL);
const run = randomUUID().slice(0, 8);
const WEBHOOK_SECRET = `whsec_${Buffer.from('p18-email-webhook-secret').toString('base64')}`;
const UNSUB_SECRET = 'u'.repeat(40);
const ENV = {
  RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STUDIO_UNSUBSCRIBE_SECRET: UNSUB_SECRET,
};
const silent = pino({ level: 'silent' });

function fakeTransport() {
  const sent: OutgoingEmail[] = [];
  let next: (() => never) | undefined;
  const transport: EmailTransport & { sent: OutgoingEmail[]; failNext(fn: () => never): void } = {
    sent,
    failNext(fn) {
      next = fn;
    },
    async send(email) {
      if (next) {
        const fail = next;
        next = undefined;
        fail();
      }
      sent.push(email);
      return { id: `em_${randomUUID()}`, alreadySent: false };
    },
  };
  return transport;
}

describe.skipIf(!hasDb)('Phase 18 email (Resend)', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `p18-email-${run}`;
  const users = {
    amara: { id: `amara-${run}`, email: `amara-${run}@example.com`, locale: 'fr' },
    ben: { id: `ben-${run}`, email: `ben-${run}@example.com`, locale: null },
    unverified: { id: `unv-${run}`, email: `unv-${run}@example.com`, locale: null },
  };
  const addresses = Object.values(users).map((u) => u.email);
  let queue: InlineJobQueue;
  let transport: ReturnType<typeof fakeTransport>;
  let deps: PipelineDeps;
  let api: ReturnType<typeof installApi>;

  const attempt = (outboxId: string, attemptsMade = 0) =>
    executeJob(
      'send-email',
      { organisationId: org, runId: outboxId, planTier: 'STANDARD', outboxId },
      deps,
      { attemptsMade, maxAttempts: 6 },
    );

  beforeAll(async () => {
    for (const [name, u] of Object.entries(users)) {
      await db.user.create({
        data: {
          id: u.id,
          name: name === 'amara' ? 'Amara' : 'Ben',
          email: u.email,
          emailVerified: name !== 'unverified',
          locale: u.locale,
        },
      });
    }
    api = installApi(db, {
      amara: tenant(org, ['studio:project:read'], users.amara.id),
      ghost: tenant(org, ['studio:project:read'], `ghost-${run}`),
    });
  });

  beforeEach(() => {
    queue = new InlineJobQueue();
    transport = fakeTransport();
    deps = {
      db,
      queue,
      logger: silent,
      now: Date.now,
      email: {
        transport,
        config: {
          apiKey: 're_test',
          from: 'PostMind Studio <no-reply@mail.example.com>',
          replyTo: 'support@example.com',
          appUrl: APP_URL,
          supportEmail: 'support@example.com',
          unsubscribeSecret: UNSUB_SECRET,
        },
      },
    } as unknown as PipelineDeps;
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.emailOutbox.deleteMany({ where: { toAddress: { in: addresses } } });
    await db.emailSuppression.deleteMany({
      where: { addressHash: { in: addresses.map(emailAddressHash) } },
    });
    await db.notificationPreference.deleteMany({ where: { organisationId: org } });
    await db.notification.deleteMany({ where: { organisationId: org } });
    await db.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
    await db.$disconnect();
  });

  describe('outbox', () => {
    it('records one row and one job per idempotency key', async () => {
      const outbox = createEmailOutbox({ db, queue, logger: silent });
      const email = {
        idempotencyKey: `auth:verify-${run}`,
        to: users.ben.email.toUpperCase(),
        template: 'verifyEmail' as const,
        locale: 'de',
        params: { url: `${APP_URL}/verify-email?token=t` },
        userId: users.ben.id,
      };
      const first = await outbox.enqueue(email);
      const second = await outbox.enqueue(email);
      expect(first).toMatchObject({ queued: true, suppressed: false, duplicate: false });
      expect(second).toMatchObject({ id: first.id, queued: true, duplicate: true });
      const row = await db.emailOutbox.findUniqueOrThrow({ where: { id: first.id } });
      expect(row).toMatchObject({ toAddress: users.ben.email, locale: 'de', state: 'pending' });
      expect(queue.history.map((j) => j.jobId)).toEqual([`send-email__${first.id}`]);
    });

    it('records suppressed addresses without queueing and refuses bad params', async () => {
      const outbox = createEmailOutbox({ db, queue, logger: silent });
      await suppressAddress(db, users.unverified.email, 'manual');
      const result = await outbox.enqueue({
        idempotencyKey: `auth:reset-${run}`,
        to: users.unverified.email,
        template: 'resetPassword',
        locale: null,
        params: { url: `${APP_URL}/reset` },
      });
      expect(result).toMatchObject({ queued: false, suppressed: true });
      expect(queue.history).toEqual([]);
      await expect(
        outbox.enqueue({
          idempotencyKey: `auth:bad-${run}`,
          to: users.ben.email,
          template: 'resetPassword',
          locale: 'en-GB',
          params: { url: 'javascript:alert(1)' },
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        outbox.enqueue({
          idempotencyKey: `auth:bad2-${run}`,
          to: 'not-an-address',
          template: 'resetPassword',
          locale: 'en-GB',
          params: { url: `${APP_URL}/r` },
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('keeps the row pending when the queue is down (the sweeper sends it later)', async () => {
      const broken = { add: vi.fn(async () => Promise.reject(new Error('redis down'))) };
      const outbox = createEmailOutbox({ db, queue: broken as never, logger: silent });
      const result = await outbox.enqueue({
        idempotencyKey: `auth:queue-down-${run}`,
        to: users.ben.email,
        template: 'passwordChanged',
        locale: 'en-GB',
        params: {},
      });
      expect(result.queued).toBe(true);
      const row = await db.emailOutbox.findUniqueOrThrow({ where: { id: result.id } });
      expect(row.state).toBe('pending');
    });

    it('the production AuthMailer writes the outbox in resend mode, logs only in core mode', async () => {
      const mailer = createAuthMailer({ db, queue, logger: silent, env: {} });
      await expect(
        mailer.sendAuthEmail(
          'invite',
          users.ben.email,
          {
            url: `${APP_URL}/invite/x`,
            organisationName: 'Acme',
            inviterName: 'Amara',
            role: 'viewer',
          },
          'es',
          { idempotencyKey: `invite:${run}`, organisationId: org },
        ),
      ).resolves.toEqual({ queued: true, suppressed: false });
      const row = await db.emailOutbox.findUniqueOrThrow({
        where: { idempotencyKey: `invite:${run}` },
      });
      expect(row).toMatchObject({ template: 'invite', locale: 'es', organisationId: org });
      const coreMailer = createAuthMailer({
        db,
        queue,
        logger: silent,
        env: { STUDIO_MODE: 'core' },
      });
      await coreMailer.sendAuthEmail('resetPassword', users.ben.email, { url: APP_URL }, 'en-GB', {
        idempotencyKey: `core:${run}`,
      });
      expect(await db.emailOutbox.count({ where: { idempotencyKey: `core:${run}` } })).toBe(0);
    });
  });

  describe('send-email job', () => {
    async function queued(key: string, template = 'resetPassword' as const) {
      const outbox = createEmailOutbox({ db, queue, logger: silent });
      return outbox.enqueue({
        idempotencyKey: key,
        to: users.ben.email,
        template,
        locale: 'it',
        params: { url: `${APP_URL}/reset-password?token=secret-${run}` },
        organisationId: org,
        userId: users.ben.id,
      });
    }

    it('renders in the row’s locale, sends with the idempotency key and redacts the link', async () => {
      const { id } = await queued(`job:ok-${run}`);
      await attempt(id);
      expect(transport.sent).toHaveLength(1);
      const email = transport.sent[0]!;
      expect(email).toMatchObject({
        to: users.ben.email,
        from: 'PostMind Studio <no-reply@mail.example.com>',
        replyTo: 'support@example.com',
        subject: 'Reimposta la password',
        idempotencyKey: `job:ok-${run}`,
        tags: [{ name: 'template', value: 'resetPassword' }],
      });
      expect(email.headers).toBeUndefined();
      expect(email.html).toContain(`secret-${run}`);
      const row = await db.emailOutbox.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ state: 'sent', attempts: 1 });
      expect(row.providerMessageId).toMatch(/^em_/);
      expect(JSON.stringify(row.params)).not.toContain(`secret-${run}`);
      // A second run of the same job is a no-op.
      await attempt(id);
      expect(transport.sent).toHaveLength(1);
    });

    it('retries a retryable failure, then fails the row after the last attempt', async () => {
      const { id } = await queued(`job:retry-${run}`);
      transport.failNext(() => {
        throw new ProviderError('resend', 'rate_limit_exceeded', '429', true);
      });
      await expect(attempt(id, 0)).rejects.toBeInstanceOf(ProviderError);
      let row = await db.emailOutbox.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ state: 'pending', attempts: 1 });
      expect(row.lastError).toContain('429');
      transport.failNext(() => {
        throw new ProviderError('resend', 'application_error', '500', true);
      });
      await expect(attempt(id, 5)).rejects.toBeInstanceOf(ProviderError);
      row = await db.emailOutbox.findUniqueOrThrow({ where: { id } });
      expect(row.state).toBe('failed');
    });

    it('fails at once on a non-retryable error and marks the notification failed', async () => {
      const note = await db.notification.create({
        data: {
          organisationId: org,
          userId: users.ben.id,
          kind: 'milestone',
          title: 't',
          body: 'b',
        },
      });
      const outbox = createEmailOutbox({ db, queue, logger: silent });
      const { id } = await outbox.enqueue({
        idempotencyKey: `notification:${note.id}:${users.ben.id}`,
        to: users.ben.email,
        template: 'notification',
        locale: 'en-GB',
        params: { kind: 'milestone', subject: 's', text: 't', link: null },
        organisationId: org,
        userId: users.ben.id,
      });
      transport.failNext(() => {
        throw new ProviderError('resend', 'validation_error', '422', false);
      });
      await expect(attempt(id)).rejects.toBeInstanceOf(UnrecoverableError);
      expect((await db.emailOutbox.findUniqueOrThrow({ where: { id } })).state).toBe('failed');
      expect(
        (await db.notification.findUniqueOrThrow({ where: { id: note.id } })).emailStatus,
      ).toBe('failed');
    });

    it('never sends to an address suppressed after queueing', async () => {
      const outbox = createEmailOutbox({ db, queue, logger: silent });
      const temp = `temp-${run}@example.com`;
      const { id } = await outbox.enqueue({
        idempotencyKey: `job:supp-${run}`,
        to: temp,
        template: 'passwordChanged',
        locale: 'en-GB',
        params: {},
      });
      await suppressAddress(db, temp, 'complaint');
      await attempt(id);
      expect(transport.sent).toHaveLength(0);
      expect((await db.emailOutbox.findUniqueOrThrow({ where: { id } })).state).toBe('suppressed');
      await db.emailOutbox.deleteMany({ where: { toAddress: temp } });
      await db.emailSuppression.deleteMany({ where: { addressHash: emailAddressHash(temp) } });
    });

    it('the sweeper re-enqueues stale pending rows and purges old finished rows', async () => {
      const stale = await db.emailOutbox.create({
        data: {
          idempotencyKey: `sweep:stale-${run}`,
          toAddress: users.ben.email,
          template: 'passwordChanged',
          locale: 'en-GB',
          params: {},
          organisationId: org,
        },
      });
      const old = await db.emailOutbox.create({
        data: {
          idempotencyKey: `sweep:old-${run}`,
          toAddress: users.ben.email,
          template: 'passwordChanged',
          locale: 'en-GB',
          params: {},
          state: 'delivered',
          createdAt: new Date(Date.now() - 91 * 24 * 60 * 60_000),
        },
      });
      const later = { ...deps, now: () => Date.now() + 6 * 60_000 } as PipelineDeps;
      await sweepEmailOutbox(
        { organisationId: 'postmind-platform', runId: 'sweep', planTier: 'STANDARD' },
        later,
      );
      expect(queue.history.map((j) => j.jobId)).toContain(`send-email__${stale.id}`);
      expect(await db.emailOutbox.findUnique({ where: { id: old.id } })).toBeNull();
    });
  });

  describe('Resend webhook', () => {
    function signed(body: unknown, options: { secret?: string; at?: number } = {}) {
      const text = JSON.stringify(body);
      const id = `msg_${randomUUID()}`;
      const ts = String(Math.floor((options.at ?? Date.now()) / 1000));
      return new Request(`${APP_URL}/api/email/resend/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'svix-id': id,
          'svix-timestamp': ts,
          'svix-signature': signSvix(options.secret ?? WEBHOOK_SECRET, id, ts, text),
        },
        body: text,
      });
    }
    const hook = (req: Request) => handleResendWebhook(req, async () => api.deps, ENV);

    async function sentRow(key: string) {
      return db.emailOutbox.create({
        data: {
          idempotencyKey: key,
          toAddress: users.ben.email,
          template: 'passwordChanged',
          locale: 'en-GB',
          params: {},
          state: 'sent',
          providerMessageId: `em_${key}`,
          organisationId: org,
        },
      });
    }

    it('marks delivery and ignores events it does not handle', async () => {
      const row = await sentRow(`wh:delivered-${run}`);
      const res = await hook(
        signed({ type: 'email.delivered', data: { email_id: row.providerMessageId, to: [] } }),
      );
      expect(res.status).toBe(200);
      expect((await db.emailOutbox.findUniqueOrThrow({ where: { id: row.id } })).state).toBe(
        'delivered',
      );
      expect((await hook(signed({ type: 'email.opened', data: {} }))).status).toBe(200);
    });

    it('suppresses hard bounces and complaints (hashed) and audits it', async () => {
      const bounced = `bounce-${run}@example.com`;
      const complained = `complaint-${run}@example.com`;
      const row = await sentRow(`wh:bounce-${run}`);
      api.audits.length = 0;
      await hook(
        signed({
          type: 'email.bounced',
          data: {
            email_id: row.providerMessageId,
            to: [bounced],
            bounce: { type: 'Permanent', subType: 'General', message: 'm' },
          },
        }),
      );
      await hook(
        signed({ type: 'email.complained', data: { email_id: 'em_x', to: [complained] } }),
      );
      expect(await isSuppressed(db, bounced)).toBe(true);
      expect(await isSuppressed(db, complained)).toBe(true);
      expect((await db.emailOutbox.findUniqueOrThrow({ where: { id: row.id } })).state).toBe(
        'bounced',
      );
      const stored = await db.emailSuppression.findMany({
        where: { addressHash: { in: [bounced, complained].map(emailAddressHash) } },
      });
      expect(stored.map((s) => s.reason).sort()).toEqual(['bounce', 'complaint']);
      expect(api.audits.map((a) => a.action)).toEqual([
        'studio.email.suppressed',
        'studio.email.suppressed',
      ]);
      expect(JSON.stringify(api.audits)).not.toContain('@example.com');
      await db.emailSuppression.deleteMany({
        where: { addressHash: { in: [bounced, complained].map(emailAddressHash) } },
      });
    });

    it('does not suppress on a temporary bounce', async () => {
      const soft = `soft-${run}@example.com`;
      await hook(
        signed({
          type: 'email.bounced',
          data: { email_id: 'em_none', to: [soft], bounce: { type: 'Temporary' } },
        }),
      );
      expect(await isSuppressed(db, soft)).toBe(false);
    });

    it('rejects invalid and stale signatures with 400 and changes nothing', async () => {
      const victim = `victim-${run}@example.com`;
      const body = { type: 'email.complained', data: { email_id: 'em_y', to: [victim] } };
      const forged = await hook(
        signed(body, { secret: `whsec_${Buffer.from('x').toString('base64')}` }),
      );
      expect(forged.status).toBe(400);
      expect(await forged.json()).toMatchObject({ error: 'invalid_signature' });
      const stale = await hook(signed(body, { at: Date.now() - 10 * 60_000 }));
      expect(stale.status).toBe(400);
      const unsigned = await hook(
        new Request(`${APP_URL}/api/email/resend/webhook`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      );
      expect(unsigned.status).toBe(400);
      expect(await isSuppressed(db, victim)).toBe(false);
    });

    it('answers 500 when the signing secret is not configured', async () => {
      const res = await handleResendWebhook(
        signed({ type: 'email.delivered', data: {} }),
        async () => api.deps,
        {},
      );
      expect(res.status).toBe(500);
    });
  });

  describe('one-click unsubscribe', () => {
    const tokenFor = (userId: string) =>
      signUnsubscribeToken({ userId, organisationId: org, kind: 'milestone' }, UNSUB_SECRET);
    const unsubscribe = (method: string, token: string, body?: string) =>
      handleUnsubscribe(
        new Request(`${APP_URL}/api/email/unsubscribe?token=${encodeURIComponent(token)}`, {
          method,
          ...(body !== undefined && {
            body,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
          }),
        }),
        async () => api.deps,
        ENV,
      );

    it('GET shows a confirm page in the user’s language and changes nothing', async () => {
      const res = await unsubscribe('GET', tokenFor(users.amara.id));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('cache-control')).toBe('no-store');
      const html = await res.text();
      expect(html).toContain('lang="fr"');
      expect(html).toContain('Ne plus recevoir ces e-mails');
      expect(html).toContain('method="post"');
      expect(
        await db.notificationPreference.count({ where: { organisationId: org, email: false } }),
      ).toBe(0);
    });

    it('a mail client’s one-click POST turns email off for that kind and is audited', async () => {
      await db.notificationPreference.create({
        data: { organisationId: org, userId: users.amara.id, kind: 'milestone', email: true },
      });
      api.audits.length = 0;
      const res = await unsubscribe('POST', tokenFor(users.amara.id), 'List-Unsubscribe=One-Click');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('unsubscribed\n');
      const pref = await db.notificationPreference.findUniqueOrThrow({
        where: {
          organisationId_userId_kind: {
            organisationId: org,
            userId: users.amara.id,
            kind: 'milestone',
          },
        },
      });
      expect(pref).toMatchObject({ email: false, inApp: true });
      expect(api.audits[0]).toMatchObject({
        actorUserId: users.amara.id,
        organisationId: org,
        action: 'studio.notification_preferences.unsubscribe',
        metadata: { kind: 'milestone', oneClick: true },
      });
    });

    it('the page’s own POST shows the done page', async () => {
      const res = await unsubscribe('POST', tokenFor(users.ben.id), '');
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('You are unsubscribed');
    });

    it('a tampered token gets the invalid page and changes nothing', async () => {
      const token = tokenFor(users.ben.id);
      const tampered = `${token.slice(0, -3)}AAA`;
      expect(verifyUnsubscribeToken(tampered, UNSUB_SECRET)).toBeNull();
      const res = await unsubscribe('POST', tampered, 'List-Unsubscribe=One-Click');
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('This link does not work');
    });
  });

  describe('notification email path', () => {
    it('emails opted-in, verified users in their own locale with an unsubscribe link', async () => {
      const preferences = createPreferenceLookup(db);
      for (const u of Object.values(users)) {
        await db.notificationPreference.upsert({
          where: {
            organisationId_userId_kind: {
              organisationId: org,
              userId: u.id,
              kind: 'publication_failed',
            },
          },
          create: { organisationId: org, userId: u.id, kind: 'publication_failed', email: true },
          update: { email: true },
        });
      }
      const notifier = createNotifier({
        db,
        logger: silent,
        sender: { send: async () => undefined },
        preferences,
        emailPreferences: preferences,
        email: createEmailSender({ db, queue, logger: silent, env: {} }),
        appUrl: APP_URL,
      });
      const result = await notifier.notify({
        organisationId: org,
        userId: null,
        kind: 'publication_failed',
        title: 'Publishing “Launch” to TikTok failed',
        body: 'Token expired — open the project to retry.',
        link: '/projects/p1',
        message: {
          key: 'publicationFailed',
          params: { name: 'Launch', platform: 'tiktok', reason: 'Token expired' },
        },
      });
      expect(result.emailStatus).toBe('sent');
      const rows = await db.emailOutbox.findMany({
        where: { idempotencyKey: { startsWith: `notification:${result.id}:` } },
      });
      // The unverified user is dropped.
      expect(rows.map((r) => r.userId).sort()).toEqual([users.amara.id, users.ben.id].sort());
      const amaraRow = rows.find((r) => r.userId === users.amara.id)!;
      expect(amaraRow.locale).toBe('fr');
      await attempt(amaraRow.id);
      const email = transport.sent[0]!;
      expect(email.subject).toBe('Échec de la publication de « Launch » sur TikTok');
      expect(email.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
      const link = /<(https?:\/\/[^>]+)>/.exec(email.headers?.['List-Unsubscribe'] ?? '')?.[1];
      const token = new URL(link ?? 'http://x').searchParams.get('token');
      expect(verifyUnsubscribeToken(token, UNSUB_SECRET)).toEqual({
        userId: users.amara.id,
        organisationId: org,
        kind: 'publication_failed',
      });
      expect(email.text).toContain(link);
    });
  });

  describe('notification preferences: email delivery state', () => {
    it('is active, then suppressed after a bounce, and pending_setup without a sender', async () => {
      await db.emailSuppression.deleteMany({
        where: { addressHash: emailAddressHash(users.amara.email) },
      });
      expect((await call(prefsRoute.GET, { token: 'amara' })).json.emailDelivery).toBe('active');
      expect((await call(prefsRoute.GET, { token: 'ghost' })).json.emailDelivery).toBe('active');
      await suppressAddress(db, users.amara.email, 'bounce');
      expect((await call(prefsRoute.GET, { token: 'amara' })).json.emailDelivery).toBe(
        'suppressed',
      );
      api.deps.modes = {
        mode: 'core',
        identity: 'core',
        auditSink: 'core',
        email: 'none',
        metaConnect: 'core',
        billing: 'core',
        businesses: 'core',
      };
      expect((await call(prefsRoute.GET, { token: 'amara' })).json.emailDelivery).toBe(
        'pending_setup',
      );
      delete api.deps.modes;
    });
  });
});
