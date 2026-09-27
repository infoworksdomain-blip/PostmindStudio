import { Prisma } from '@prisma/client';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createNotifier, notifySafely, staffOrganisationIds } from './notifier';
import type { OutboundNotification } from './sender';

type Row = {
  id: string;
  organisationId: string;
  userId: string | null;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  dedupeKey: string | null;
  readAt: Date | null;
  createdAt: Date;
};

function fakeDb() {
  const rows: Row[] = [];
  const create = vi.fn(async ({ data }: { data: Omit<Row, 'id' | 'readAt' | 'createdAt'> }) => {
    if (
      data.dedupeKey &&
      rows.some((r) => r.organisationId === data.organisationId && r.dedupeKey === data.dedupeKey)
    ) {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      });
    }
    const row: Row = { ...data, id: `n${rows.length + 1}`, readAt: null, createdAt: new Date(0) };
    rows.push(row);
    return row;
  });
  const createManyAndReturn = vi.fn(
    async ({ data }: { data: Array<Omit<Row, 'id' | 'readAt' | 'createdAt'>> }) => {
      const out: Row[] = [];
      for (const item of data) {
        try {
          out.push(await create({ data: item }));
        } catch (err) {
          if ((err as { code?: string }).code !== 'P2002') throw err;
        }
      }
      return out;
    },
  );
  return { db: { notification: { create, createManyAndReturn } }, rows, create };
}

function setup(staff: string[] = []) {
  const { db, rows, create } = fakeDb();
  const sent: OutboundNotification[] = [];
  const logger = pino({ level: 'silent' });
  const notifier = createNotifier({
    db: db as never,
    logger,
    sender: { send: async (n) => void sent.push(n) },
    staffOrgIds: () => staff,
  });
  return { notifier, rows, sent, create, logger };
}

describe('createNotifier', () => {
  it('stores then sends, and deduplicates by (organisation, dedupeKey)', async () => {
    const t = setup();
    const input = {
      organisationId: 'org-1',
      userId: 'user-1',
      kind: 'generation_complete' as const,
      title: 'x'.repeat(500),
      body: 'ready',
      link: '/projects/p',
      dedupeKey: 'generation_complete:p:r',
    };
    expect(await t.notifier.notify(input)).toEqual({ created: true, id: 'n1' });
    expect(await t.notifier.notify(input)).toEqual({ created: false });
    // Another organisation may use the same key.
    expect((await t.notifier.notify({ ...input, organisationId: 'org-2' })).created).toBe(true);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0]?.title).toHaveLength(200);
    expect(t.sent.map((s) => [s.audience, s.organisationId])).toEqual([
      ['organisation', 'org-1'],
      ['organisation', 'org-2'],
    ]);
  });

  it('without a dedupeKey every call is a new notification; other DB errors propagate', async () => {
    const t = setup();
    const input = { organisationId: 'o', kind: 'cost_alert' as const, title: 't', body: 'b' };
    await t.notifier.notify(input);
    await t.notifier.notify(input);
    expect(t.rows).toHaveLength(2);
    t.create.mockRejectedValueOnce(new Error('db down'));
    await expect(t.notifier.notify(input)).rejects.toThrow('db down');
  });

  it('notifies every staff organisation once, with one staff webhook delivery', async () => {
    const t = setup(['staff-a', 'staff-b']);
    const input = { kind: 'cost_paused' as const, title: 'Global cap', body: 'b', dedupeKey: 'k' };
    expect(await t.notifier.notifyStaff(input)).toBe(2);
    expect(await t.notifier.notifyStaff(input)).toBe(0);
    expect(t.rows.map((r) => [r.organisationId, r.userId])).toEqual([
      ['staff-a', null],
      ['staff-b', null],
    ]);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ audience: 'staff', organisationId: null, id: 'n1' });
  });

  it('still reaches the webhook when no staff organisation is configured', async () => {
    const t = setup([]);
    const warn = vi.spyOn(t.logger, 'warn');
    expect(await t.notifier.notifyStaff({ kind: 'cost_alert', title: 't', body: 'b' })).toBe(0);
    expect(t.sent).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });

  it('notifySafely logs instead of throwing', async () => {
    const logger = pino({ level: 'silent' });
    const error = vi.spyOn(logger, 'error');
    await notifySafely(
      {
        db: {} as never,
        logger,
        notifier: {
          notify: async () => Promise.reject(new Error('boom')),
          notifyStaff: async () => 0,
        },
      },
      { organisationId: 'o', kind: 'cost_alert', title: 't', body: 'b' },
    );
    expect(error).toHaveBeenCalledOnce();
  });

  it('parses STUDIO_PLATFORM_ORG_IDS', () => {
    expect(staffOrganisationIds({ STUDIO_PLATFORM_ORG_IDS: ' a, ,b ' })).toEqual(['a', 'b']);
  });
});
