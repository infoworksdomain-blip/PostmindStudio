import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '../../audit';
import { NotImplementedError, UpstreamServiceError } from '../../errors';
import {
  pendingCoreChannelDirectory,
  type CoreChannel,
  type CoreChannelDirectory,
} from '../core/channel-directory';
import {
  RECONCILE_ACTOR,
  reconcileMetaChannels,
  reconcileOrganisation,
  type StudioChannelRow,
} from './channel-reconciliation';

// BACKLOG 13.35: reconciliation logic against a fake Core client, ready for the day Core ships
// list-channels.

const row = (over: Partial<StudioChannelRow> & { id: string }): StudioChannelRow => ({
  organisationId: 'org-a',
  platform: 'instagram',
  platformAccountId: '1001',
  platformAccountName: '@bakery',
  state: 'active',
  ...over,
});

const core = (over: Partial<CoreChannel> = {}): CoreChannel => ({
  platform: 'instagram',
  platformAccountId: '1001',
  platformAccountName: '@bakery',
  ...over,
});

describe('reconcileOrganisation', () => {
  it('matches identical lists with no findings', () => {
    const result = reconcileOrganisation('org-a', [row({ id: 'c1' })], [core()]);
    expect(result).toEqual({ organisationId: 'org-a', matched: 1, findings: [] });
  });

  it('flags a live Studio channel Core no longer lists for disconnect', () => {
    const result = reconcileOrganisation(
      'org-a',
      [row({ id: 'c1' }), row({ id: 'c2', platform: 'facebook', platformAccountId: '2002' })],
      [core()],
    );
    expect(result.findings).toEqual([
      {
        kind: 'missing_in_core',
        channel: expect.objectContaining({ id: 'c2', platform: 'facebook' }),
        action: 'disconnect',
      },
    ]);
    expect(result.matched).toBe(1);
  });

  it('includes needs_reconnect channels but ignores revoked ones Core does not list', () => {
    const result = reconcileOrganisation(
      'org-a',
      [
        row({ id: 'c1' }),
        row({ id: 'c2', platformAccountId: '1002', state: 'needs_reconnect' }),
        row({ id: 'c3', platformAccountId: '1003', state: 'revoked' }),
      ],
      [core()],
    );
    expect(result.findings.map((f) => f.kind)).toEqual(['missing_in_core']);
  });

  it('holds instead of disconnecting every channel of an organisation', () => {
    const result = reconcileOrganisation(
      'org-a',
      [row({ id: 'c1' }), row({ id: 'c2', platformAccountId: '1002' })],
      [],
    );
    expect(result.findings.map((f) => f.kind === 'missing_in_core' && f.action)).toEqual([
      'held',
      'held',
    ]);
  });

  it('still disconnects an organisation’s only channel', () => {
    const result = reconcileOrganisation('org-a', [row({ id: 'c1' })], []);
    expect(result.findings).toEqual([
      expect.objectContaining({ kind: 'missing_in_core', action: 'disconnect' }),
    ]);
  });

  it('reports channels Core lists that Studio lacks or revoked', () => {
    const result = reconcileOrganisation(
      'org-a',
      [row({ id: 'c3', platformAccountId: '1003', state: 'revoked' })],
      [
        core({ platformAccountId: '1003' }),
        core({ platform: 'facebook', platformAccountId: '2002', platformAccountName: undefined }),
      ],
    );
    expect(result.findings).toEqual([
      {
        kind: 'revoked_in_studio',
        channel: expect.objectContaining({ id: 'c3' }),
        action: 'core_must_register',
      },
      {
        kind: 'missing_in_studio',
        platform: 'facebook',
        platformAccountId: '2002',
        platformAccountName: null,
        action: 'core_must_register',
      },
    ]);
    expect(result.matched).toBe(0);
  });

  it('proposes Core’s display name when it changed', () => {
    const result = reconcileOrganisation(
      'org-a',
      [row({ id: 'c1' })],
      [core({ platformAccountName: '@bakery_leeds' })],
    );
    expect(result.findings).toEqual([
      {
        kind: 'name_changed',
        channel: expect.objectContaining({ id: 'c1' }),
        coreName: '@bakery_leeds',
        action: 'rename',
      },
    ]);
  });
});

function fakeDb(initial: StudioChannelRow[]) {
  const rows = initial.map((r) => ({ ...r, encryptedAccessToken: 'sealed' }));
  const matches = (r: (typeof rows)[number], where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'platform' && v && typeof v === 'object' && 'in' in v) {
        return (v as { in: string[] }).in.includes(r.platform);
      }
      return (r as Record<string, unknown>)[k] === v;
    });
  const platformConnection = {
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows
        .filter((r) => matches(r, where))
        .sort(
          (a, b) => a.organisationId.localeCompare(b.organisationId) || a.id.localeCompare(b.id),
        ),
    ),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
    ),
    findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
      const found = rows.find((r) => r.id === where.id);
      if (!found) throw new Error('not found');
      return found;
    }),
  };
  return { db: { platformConnection }, rows };
}

function fakeDirectory(lists: Record<string, CoreChannel[] | Error>): CoreChannelDirectory {
  return {
    ready: true,
    listChannels: vi.fn(async (organisationId: string) => {
      const entry = lists[organisationId] ?? [];
      if (entry instanceof Error) throw entry;
      return entry;
    }),
  };
}

const logger = pino({ level: 'silent' });
const now = () => Date.parse('2026-09-29T03:30:00Z');

describe('reconcileMetaChannels', () => {
  const studio = [
    row({ id: 'a1' }),
    row({
      id: 'a2',
      platform: 'facebook',
      platformAccountId: '2002',
      platformAccountName: 'Bakery',
    }),
    row({ id: 'b1', organisationId: 'org-b', platformAccountId: '3003' }),
    row({ id: 't1', organisationId: 'org-a', platform: 'tiktok', platformAccountId: 'tt' }),
  ];

  it('is an honest 501 until Core ships list-channels, without touching the database', async () => {
    const { db } = fakeDb(studio);
    await expect(
      reconcileMetaChannels(
        { db: db as never, directory: pendingCoreChannelDirectory, logger, now },
        { apply: true },
      ),
    ).rejects.toBeInstanceOf(NotImplementedError);
    expect(db.platformConnection.findMany).not.toHaveBeenCalled();
    expect(db.platformConnection.updateMany).not.toHaveBeenCalled();
  });

  it('reports without changing anything when apply is false', async () => {
    const { db, rows } = fakeDb(studio);
    const report = await reconcileMetaChannels(
      {
        db: db as never,
        directory: fakeDirectory({
          'org-a': [core()],
          'org-b': [core({ platformAccountId: '3003' })],
        }),
        logger,
        now,
      },
      { apply: false },
    );
    expect(report.applied).toBe(false);
    expect(report.checkedAt).toBe('2026-09-29T03:30:00.000Z');
    expect(report.totals).toEqual({ organisations: 2, matched: 2, findings: 1, disconnected: 0 });
    expect(rows.find((r) => r.id === 'a2')?.state).toBe('active');
    expect(db.platformConnection.updateMany).not.toHaveBeenCalled();
  });

  it('applies disconnects and renames with an audit entry, and only reads Meta channels', async () => {
    const { db, rows } = fakeDb(studio);
    const audits: AuditEntry[] = [];
    const directory = fakeDirectory({
      'org-a': [core({ platformAccountName: '@bakery_leeds' })],
      'org-b': [core({ platformAccountId: '3003' })],
    });
    const report = await reconcileMetaChannels(
      { db: db as never, directory, logger, now, audit: (e) => audits.push(e) },
      { apply: true },
    );
    expect(report.totals.disconnected).toBe(1);
    const a2 = rows.find((r) => r.id === 'a2');
    expect(a2?.state).toBe('revoked');
    expect(rows.find((r) => r.id === 'a1')?.platformAccountName).toBe('@bakery_leeds');
    expect(rows.find((r) => r.id === 't1')?.state).toBe('active');
    expect(audits).toEqual([
      expect.objectContaining({
        actorUserId: RECONCILE_ACTOR,
        organisationId: 'org-a',
        action: 'studio.connection.meta_reconcile_disconnect',
        resource: { type: 'platform_connection', id: 'a2' },
      }),
    ]);
  });

  it('never disconnects a held finding', async () => {
    const { db, rows } = fakeDb(studio);
    await reconcileMetaChannels(
      { db: db as never, directory: fakeDirectory({ 'org-a': [], 'org-b': [] }), logger, now },
      { apply: true },
    );
    // org-a: both channels missing → held; org-b: its only channel missing → disconnected.
    expect(rows.find((r) => r.id === 'a1')?.state).toBe('active');
    expect(rows.find((r) => r.id === 'a2')?.state).toBe('active');
    expect(rows.find((r) => r.id === 'b1')?.state).toBe('revoked');
  });

  it('records a per-organisation Core failure and carries on', async () => {
    const { db } = fakeDb(studio);
    const report = await reconcileMetaChannels(
      {
        db: db as never,
        directory: fakeDirectory({
          'org-a': new UpstreamServiceError('Core list failed'),
          'org-b': [core({ platformAccountId: '3003' })],
        }),
        logger,
        now,
      },
      { apply: true },
    );
    expect(report.errors).toEqual([
      { organisationId: 'org-a', error: 'upstream_error', message: 'Core list failed' },
    ]);
    expect(report.organisations.map((o) => o.organisationId)).toEqual(['org-b']);
  });

  it('scopes to one organisation and still asks Core when Studio has none of its channels', async () => {
    const { db } = fakeDb(studio);
    const directory = fakeDirectory({ 'org-c': [core({ platformAccountId: '9009' })] });
    const report = await reconcileMetaChannels(
      { db: db as never, directory, logger, now },
      { apply: false, organisationId: 'org-c' },
    );
    expect(directory.listChannels).toHaveBeenCalledTimes(1);
    expect(report.organisations[0]?.findings[0]?.kind).toBe('missing_in_studio');
  });
});
