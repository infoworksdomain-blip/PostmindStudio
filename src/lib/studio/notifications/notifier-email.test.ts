import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { UpstreamServiceError } from '../../errors';
import { CoreEmailSender, type EmailMessage, type EmailSender } from './email';
import { createNotifier } from './notifier';

// BACKLOG 13.33: the notifier emails only users who enabled email for the kind, and records
// notifications.emailStatus (pending_setup while no sender exists or Core's API is missing).

function fakeDb() {
  let n = 0;
  const updates: Array<{ id: string; emailStatus: string }> = [];
  const row = (data: Record<string, unknown>) => ({
    id: `n${++n}`,
    readAt: null,
    createdAt: new Date(0),
    link: null,
    dedupeKey: null,
    userId: null,
    ...data,
  });
  const db = {
    notification: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => row(data)),
      createManyAndReturn: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) =>
        data.map(row),
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { emailStatus: string } }) => {
          updates.push({ id: where.id, emailStatus: data.emailStatus });
          return {};
        },
      ),
    },
  };
  return { db, updates };
}

function setup(options: {
  recipients?: string[];
  email?: EmailSender | null;
  withPreferences?: boolean;
}) {
  const { db, updates } = fakeDb();
  const emailRecipients = vi.fn(async () => options.recipients ?? []);
  const notifier = createNotifier({
    db: db as never,
    logger: pino({ level: 'silent' }),
    sender: { send: async () => undefined },
    staffOrgIds: () => [],
    email: options.email === undefined ? null : options.email,
    appUrl: 'https://studio.test/',
    ...(options.withPreferences !== false && { emailPreferences: { emailRecipients } }),
  });
  return { notifier, updates, emailRecipients };
}

const input = {
  organisationId: 'org-1',
  userId: 'u1',
  kind: 'publication_failed' as const,
  title: 'Publishing failed',
  body: 'Retry from the project page.',
  link: '/projects/p1',
};

describe('notifier email step', () => {
  it('does nothing when no preferences service is wired', async () => {
    const { notifier, updates } = setup({ withPreferences: false });
    expect(await notifier.notify(input)).toEqual({ created: true, id: 'n1' });
    expect(updates).toEqual([]);
  });

  it('does nothing when no one enabled email for the kind', async () => {
    const { notifier, updates, emailRecipients } = setup({ recipients: [] });
    const result = await notifier.notify(input);
    expect(emailRecipients).toHaveBeenCalledWith({
      organisationId: 'org-1',
      userId: 'u1',
      kind: 'publication_failed',
    });
    expect(result.emailStatus).toBeUndefined();
    expect(updates).toEqual([]);
  });

  it('records pending_setup when email is enabled but no sender is configured', async () => {
    const { notifier, updates } = setup({ recipients: ['u1'], email: null });
    expect((await notifier.notify(input)).emailStatus).toBe('pending_setup');
    expect(updates).toEqual([{ id: 'n1', emailStatus: 'pending_setup' }]);
  });

  it('records pending_setup when the Core sender is selected but Core has no email API', async () => {
    const { notifier, updates } = setup({ recipients: ['u1'], email: new CoreEmailSender() });
    expect((await notifier.notify(input)).emailStatus).toBe('pending_setup');
    expect(updates).toEqual([{ id: 'n1', emailStatus: 'pending_setup' }]);
  });

  it('sends to opted-in users with an absolute link and records sent', async () => {
    const sent: EmailMessage[] = [];
    const email: EmailSender = { provider: 'core', send: async (m) => void sent.push(m) };
    const { notifier, updates } = setup({ recipients: ['u1', 'u2'], email });
    await notifier.notify({ ...input, userId: null });
    expect(sent).toEqual([
      {
        notificationId: 'n1',
        organisationId: 'org-1',
        recipientUserIds: ['u1', 'u2'],
        kind: 'publication_failed',
        subject: 'Publishing failed',
        text: 'Retry from the project page.',
        link: 'https://studio.test/projects/p1',
      },
    ]);
    expect(updates).toEqual([{ id: 'n1', emailStatus: 'sent' }]);
  });

  it('records failed when the sender errors, without failing the notification', async () => {
    const email: EmailSender = {
      provider: 'core',
      send: async () => {
        throw new UpstreamServiceError('down');
      },
    };
    const { notifier, updates } = setup({ recipients: ['u1'], email });
    expect((await notifier.notify(input)).created).toBe(true);
    expect(updates).toEqual([{ id: 'n1', emailStatus: 'failed' }]);
  });

  it('never fails the notification when the preferences lookup throws', async () => {
    const { db } = fakeDb();
    const notifier = createNotifier({
      db: db as never,
      logger: pino({ level: 'silent' }),
      sender: { send: async () => undefined },
      email: null,
      emailPreferences: {
        emailRecipients: async () => {
          throw new UpstreamServiceError('prefs down');
        },
      },
    });
    await expect(notifier.notify(input)).resolves.toEqual({ created: true, id: 'n1' });
  });

  it('never emails staff notifications', async () => {
    const { notifier, emailRecipients } = setup({ recipients: ['u1'] });
    await notifier.notifyStaff({ kind: 'cost_alert', title: 't', body: 'b' });
    expect(emailRecipients).not.toHaveBeenCalled();
  });
});

describe('notifier email step: keyed messages (Phase 18 §2.8)', () => {
  it('passes the keyed form so each recipient gets their own language', async () => {
    const sent: EmailMessage[] = [];
    const email: EmailSender = { provider: 'resend', send: async (m) => void sent.push(m) };
    const { notifier } = setup({ recipients: ['u1'], email });
    await notifier.notify({
      ...input,
      message: {
        key: 'publicationFailed',
        params: { name: 'Launch', platform: 'tiktok', reason: 'r' },
      },
    });
    expect(sent[0]?.message).toEqual({
      key: 'publicationFailed',
      params: { name: 'Launch', platform: 'tiktok', reason: 'r' },
    });
  });
});
