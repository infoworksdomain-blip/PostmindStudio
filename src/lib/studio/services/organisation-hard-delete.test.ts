import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../../../../test/helpers/memory-storage';
import { ConfigurationError, UpstreamServiceError, ValidationError } from '../../errors';
import {
  DEFAULT_PURGE_GRACE_DAYS,
  graceUntilFrom,
  hardDeleteDuePurges,
  hardDeleteOrganisation,
  purgeGraceDays,
  type HardDeleteDeps,
} from './organisation-hard-delete';
import { purgeOrganisation } from './organisation-purge';

// BACKLOG 14.1 — grace configuration, and the hard delete's state machine on a real database:
// not purged / not due / resumable after a storage failure / already deleted.

describe('purgeGraceDays (STUDIO_PURGE_GRACE_DAYS)', () => {
  it('defaults to 30 days (Engagement handover 14.13)', () => {
    expect(purgeGraceDays({})).toBe(DEFAULT_PURGE_GRACE_DAYS);
    expect(DEFAULT_PURGE_GRACE_DAYS).toBe(30);
    expect(purgeGraceDays({ STUDIO_PURGE_GRACE_DAYS: ' ' })).toBe(30);
  });

  it('accepts whole days from 1 to 365 and refuses anything else', () => {
    expect(purgeGraceDays({ STUDIO_PURGE_GRACE_DAYS: '7' })).toBe(7);
    for (const bad of ['0', '-1', '1.5', '366', 'thirty']) {
      expect(() => purgeGraceDays({ STUDIO_PURGE_GRACE_DAYS: bad })).toThrow(ConfigurationError);
    }
  });

  it('graceUntil is requestedAt plus whole days', () => {
    expect(graceUntilFrom(new Date('2026-09-01T00:00:00Z'), 30).toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });
});

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('hardDeleteOrganisation', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `svc-hard-${randomUUID()}`;
  const DAY = 86_400_000;
  const t0 = Date.parse('2026-09-01T00:00:00Z');

  afterAll(async () => {
    await db.organisationPurge.deleteMany({ where: { organisationId: org } });
    await db.systemFlag.deleteMany({ where: { key: { contains: org } } });
    await db.$disconnect();
  });

  const deps = (
    now: number,
    storage = memoryStorage().storage,
    audit = vi.fn(),
  ): HardDeleteDeps & { audit: ReturnType<typeof vi.fn> } => ({
    db,
    storage,
    now: () => now,
    buckets: ['assets'],
    logger: pino({ level: 'silent' }),
    audit,
    batchSize: 2,
  });

  it('refuses a malformed id, and does nothing for an org that was never purged', async () => {
    await expect(hardDeleteOrganisation(deps(t0), '')).rejects.toThrow(ValidationError);
    expect(await hardDeleteOrganisation(deps(t0), `never-${randomUUID()}`)).toEqual({
      status: 'not_purged',
    });
  });

  it('waits for the grace, resumes after a storage failure, then records the tombstone', async () => {
    for (let i = 0; i < 5; i += 1) {
      await db.notification.create({
        data: { organisationId: org, kind: 'cost_alert', title: 't', body: 'b' },
      });
    }
    await purgeOrganisation({ db, now: () => t0 }, org);
    expect(await hardDeleteOrganisation(deps(t0 + 29 * DAY), org)).toEqual({ status: 'not_due' });

    const { storage, objects } = memoryStorage();
    await storage.put({
      bucket: 'assets',
      key: `orgs/${org}/a.png`,
      body: new Uint8Array(4),
      contentType: 'image/png',
    });
    const failing = {
      ...storage,
      deleteMany: async (_bucket: string, keys: string[]) => ({
        deleted: 0,
        errors: keys.map((key) => ({ key, code: 'AccessDenied', message: 'denied' })),
      }),
    };
    await expect(hardDeleteOrganisation(deps(t0 + 31 * DAY, failing), org)).rejects.toThrow(
      UpstreamServiceError,
    );
    const stuck = await db.organisationPurge.findUniqueOrThrow({ where: { organisationId: org } });
    expect(stuck).toMatchObject({ state: 'hard_deleting', hardDeleteAttempts: 1 });
    expect(stuck.hardDeleteError).toMatch(/refused 1 deletes/);
    expect(await db.notification.count({ where: { organisationId: org } })).toBe(5);

    // The daily sweep picks it up again; batches of 2 still delete all 5 rows.
    const ok = deps(t0 + 32 * DAY, storage);
    const run = await hardDeleteDuePurges(ok);
    expect(run).toMatchObject({ deleted: [org], failed: [] });
    expect(objects.size).toBe(0);
    expect(await db.notification.count({ where: { organisationId: org } })).toBe(0);
    const tomb = await db.organisationPurge.findUniqueOrThrow({ where: { organisationId: org } });
    expect(tomb).toMatchObject({
      state: 'hard_deleted',
      hardDeleteAttempts: 2,
      hardDeleteError: null,
    });
    expect(tomb.hardDeleteStartedAt?.getTime()).toBe(t0 + 31 * DAY);
    expect(tomb.hardDeleteSummary).toMatchObject({
      tables: { notifications: 5 },
      storage: { [`assets/orgs/${org}/`]: { objects: 1, bytes: 4 } },
    });
    expect(ok.audit).toHaveBeenCalledTimes(1);

    expect(await hardDeleteOrganisation(deps(t0 + 40 * DAY), org)).toEqual({
      status: 'already_deleted',
    });
  });

  it('never hard-deletes a cancelled purge; a new purge request restarts the grace', async () => {
    const restored = `svc-hard-cancel-${randomUUID()}`;
    await db.notification.create({
      data: { organisationId: restored, kind: 'cost_alert', title: 't', body: 'b' },
    });
    await purgeOrganisation({ db, now: () => t0 }, restored);
    await db.organisationPurge.update({
      where: { organisationId: restored },
      data: { state: 'cancelled' },
    });
    expect(await hardDeleteOrganisation(deps(t0 + 31 * DAY), restored)).toEqual({
      status: 'cancelled',
    });
    expect((await hardDeleteDuePurges(deps(t0 + 31 * DAY))).deleted).not.toContain(restored);
    expect(await db.notification.count({ where: { organisationId: restored } })).toBe(1);

    const again = await purgeOrganisation({ db, now: () => t0 + 40 * DAY }, restored);
    expect(again.graceUntil).toBe(new Date(t0 + 70 * DAY).toISOString());
    expect(
      (await db.organisationPurge.findUniqueOrThrow({ where: { organisationId: restored } })).state,
    ).toBe('soft_deleted');
    await db.notification.deleteMany({ where: { organisationId: restored } });
    await db.organisationPurge.deleteMany({ where: { organisationId: restored } });
    await db.systemFlag.deleteMany({ where: { key: { contains: restored } } });
  });

  it('fails loudly when the storage cannot list or batch-delete', async () => {
    const other = `svc-hard-nolist-${randomUUID()}`;
    await purgeOrganisation({ db, now: () => t0 }, other);
    const { list: _list, deleteMany: _deleteMany, ...plain } = memoryStorage().storage;
    await expect(hardDeleteOrganisation(deps(t0 + 31 * DAY, plain), other)).rejects.toThrow(
      ConfigurationError,
    );
    await db.organisationPurge.deleteMany({ where: { organisationId: other } });
    await db.systemFlag.deleteMany({ where: { key: { contains: other } } });
  });
});
