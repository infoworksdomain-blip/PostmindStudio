import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createNotifier } from './notifier';
import {
  createPreferenceLookup,
  getPreferences,
  mutedKinds,
  preferencesPatchInput,
  updatePreferences,
} from './preferences';

// BACKLOG 13.24 — notification preferences: validation, defaults, the Prisma lookup and the
// notifier's in-app suppression (API behaviour: test/api/notification-preferences.test.ts).

type Row = { organisationId: string; userId: string; kind: string; inApp: boolean; email: boolean };

function fakeDb(initial: Row[] = []) {
  const rows = [...initial];
  const match = (where: Partial<Row>) => (r: Row) =>
    Object.entries(where).every(([k, v]) => r[k as keyof Row] === v);
  return {
    rows,
    notificationPreference: {
      findMany: vi.fn(async ({ where }: { where: Partial<Row> }) => rows.filter(match(where))),
      findUnique: vi.fn(
        async ({ where }: { where: { organisationId_userId_kind: Partial<Row> } }) =>
          rows.find(match(where.organisationId_userId_kind)) ?? null,
      ),
      upsert: vi.fn(
        async (args: {
          where: { organisationId_userId_kind: Partial<Row> };
          create: Row;
          update: Partial<Row>;
        }) => {
          const existing = rows.find(match(args.where.organisationId_userId_kind));
          if (existing) Object.assign(existing, args.update);
          else rows.push({ ...args.create });
        },
      ),
    },
  };
}

const reader = { organisationId: 'org-1', userId: 'user-1' };

describe('preferencesPatchInput', () => {
  it('accepts known kinds with inApp/email and refuses the rest', () => {
    expect(preferencesPatchInput.parse({ milestone: { email: true } })).toEqual({
      milestone: { email: true },
    });
    expect(preferencesPatchInput.safeParse({}).success).toBe(false);
    expect(preferencesPatchInput.safeParse({ marketing: { email: true } }).success).toBe(false);
    expect(preferencesPatchInput.safeParse({ milestone: {} }).success).toBe(false);
    expect(preferencesPatchInput.safeParse({ milestone: { sms: true } }).success).toBe(false);
  });
});

describe('get / update', () => {
  it('defaults every kind to in-app on, email off, and upserts changes', async () => {
    const db = fakeDb();
    const initial = await getPreferences(db as never, reader);
    expect(initial.milestone).toEqual({ inApp: true, email: false });
    expect(Object.keys(initial)).toContain('safety_review');
    const updated = await updatePreferences(db as never, reader, {
      milestone: { email: true },
      cost_alert: { inApp: false },
    });
    expect(updated.milestone).toEqual({ inApp: true, email: true });
    expect(updated.cost_alert).toEqual({ inApp: false, email: false });
    await updatePreferences(db as never, reader, { milestone: { inApp: false } });
    expect((await getPreferences(db as never, reader)).milestone).toEqual({
      inApp: false,
      email: true,
    });
    expect(await mutedKinds(db as never, reader)).toEqual(['milestone', 'cost_alert']);
  });
});

describe('createPreferenceLookup', () => {
  const db = fakeDb([
    { ...reader, kind: 'milestone', inApp: false, email: true },
    { organisationId: 'org-1', userId: 'user-2', kind: 'milestone', inApp: true, email: true },
    { organisationId: 'org-2', userId: 'user-9', kind: 'milestone', inApp: true, email: true },
  ]);
  const lookup = createPreferenceLookup(db as never);

  it('reads in-app with the default on', async () => {
    expect(await lookup.inAppEnabled({ ...reader, kind: 'milestone' })).toBe(false);
    expect(await lookup.inAppEnabled({ ...reader, kind: 'cost_alert' })).toBe(true);
  });

  it('email recipients: the user when opted in, or every opted-in member of the organisation', async () => {
    expect(await lookup.emailRecipients({ ...reader, kind: 'milestone' })).toEqual(['user-1']);
    expect(
      await lookup.emailRecipients({ organisationId: 'org-1', userId: null, kind: 'milestone' }),
    ).toEqual(['user-1', 'user-2']);
    expect(await lookup.emailRecipients({ ...reader, kind: 'cost_alert' })).toEqual([]);
  });
});

describe('notifier respects in-app preferences', () => {
  function setup(prefs: { inApp: boolean; email: string[] }) {
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'n1',
      createdAt: new Date(),
      ...data,
    }));
    const notifier = createNotifier({
      db: { notification: { create, createManyAndReturn: vi.fn(), update: vi.fn() } } as never,
      logger: pino({ level: 'silent' }),
      sender: { send: vi.fn(async () => undefined) },
      staffOrgIds: () => [],
      email: null,
      preferences: {
        inAppEnabled: vi.fn(async () => prefs.inApp),
        emailRecipients: vi.fn(async () => prefs.email),
      },
    });
    return { notifier, create };
  }
  const input = {
    organisationId: 'org-1',
    userId: 'user-1',
    kind: 'milestone' as const,
    title: 'Reached 10,000 views',
    body: 'Nice',
  };

  it('does not store a notification the user turned off in-app', async () => {
    const { notifier, create } = setup({ inApp: false, email: [] });
    expect(await notifier.notify(input)).toEqual({ created: false });
    expect(create).not.toHaveBeenCalled();
  });

  it('still stores it when the user asked for the email (the row carries emailStatus)', async () => {
    const { notifier, create } = setup({ inApp: false, email: ['user-1'] });
    expect((await notifier.notify(input)).created).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('organisation-wide notifications are always stored (hidden per reader instead)', async () => {
    const { notifier, create } = setup({ inApp: false, email: [] });
    expect((await notifier.notify({ ...input, userId: null })).created).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('delivers when preferences cannot be read', async () => {
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'n1',
      createdAt: new Date(),
      ...data,
    }));
    const notifier = createNotifier({
      db: { notification: { create } } as never,
      logger: pino({ level: 'silent' }),
      sender: { send: vi.fn(async () => undefined) },
      email: null,
      preferences: {
        inAppEnabled: vi.fn(async () => Promise.reject(new Error('db down'))),
        emailRecipients: vi.fn(async () => []),
      },
    });
    expect((await notifier.notify(input)).created).toBe(true);
  });
});
