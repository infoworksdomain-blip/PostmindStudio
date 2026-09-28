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
  planHardDelete,
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

  it('R2: deletes and counts orgs/<id>/ and intermediates/orgs/<id>/ (Storage: Cloudflare R2)', async () => {
    const r2org = `svc-hard-r2-${randomUUID()}`;
    await purgeOrganisation({ db, now: () => t0 }, r2org);
    const { storage, objects } = memoryStorage();
    const put = (key: string) =>
      storage.put({ bucket: 'assets', key, body: new Uint8Array(4), contentType: 'image/png' });
    await put(`orgs/${r2org}/uploads/u/source.mp4`);
    await put(`intermediates/orgs/${r2org}/projects/p/providers/openai/x.png`);
    await put(`intermediates/orgs/${r2org}/projects/p/providers/openai/y.png`);
    await put('intermediates/orgs/someone-else/projects/p/providers/openai/z.png');
    const r2 = { ...deps(t0 + 31 * DAY, storage), storageProvider: 'r2' as const };

    const plan = await planHardDelete(r2, r2org);
    expect(plan.storage.map((s) => [s.prefix, s.objects])).toEqual([
      [`orgs/${r2org}/`, 1],
      [`intermediates/orgs/${r2org}/`, 2],
    ]);
    expect(plan.totals.objects).toBe(3);
    // The S3 layout would only see orgs/<id>/.
    const s3plan = await planHardDelete({ ...r2, storageProvider: 's3' }, r2org);
    expect(s3plan.storage.map((s) => s.prefix)).toEqual([`orgs/${r2org}/`]);

    const out = await hardDeleteOrganisation(r2, r2org);
    expect(out.status).toBe('deleted');
    expect(out.summary?.storage).toEqual({
      [`assets/orgs/${r2org}/`]: { objects: 1, bytes: 4 },
      [`assets/intermediates/orgs/${r2org}/`]: { objects: 2, bytes: 8 },
    });
    expect([...objects.keys()]).toEqual([
      'assets/intermediates/orgs/someone-else/projects/p/providers/openai/z.png',
    ]);
    await db.organisationPurge.deleteMany({ where: { organisationId: r2org } });
    await db.systemFlag.deleteMany({ where: { key: { contains: r2org } } });
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

  it('wipes provider credentials and exports, keeps tombstones and an anonymised takedown', async () => {
    const gone = `svc-hard-p15-${randomUUID()}`;
    await db.providerCredential.create({
      data: {
        organisationId: gone,
        providerId: 'runway',
        encryptedKey: 'v1:enc:secret',
        hint: 'abcd',
        createdByUserId: 'u1',
      },
    });
    await db.dataExport.create({ data: { organisationId: gone, requestedByUserId: 'u1' } });
    await db.usageEvent.create({
      data: {
        organisationId: gone,
        eventType: 'video_generated',
        eventKey: `render:${gone}`,
        payload: {},
        occurredAt: new Date(t0),
      },
    });
    const takedown = await db.takedownRequest.create({
      data: {
        receivedAt: new Date(t0),
        source: 'policy_mailbox',
        category: 'privacy',
        requester: 'Jane Doe <jane@example.com>',
        organisationId: gone,
        publicationId: 'pub-gone',
        summary: 'Asked for removal',
        enteredByUserId: 'staff-1',
      },
    });
    await purgeOrganisation({ db, now: () => t0 }, gone);
    await db.businessPurge.create({
      data: {
        organisationId: gone,
        businessId: 'biz-1',
        graceUntil: new Date(t0),
        projectsDeleted: 0,
        publicationsCancelled: 0,
        styleMemoriesDeleted: 0,
        state: 'hard_deleted',
      },
    });

    const res = await hardDeleteOrganisation(deps(t0 + 31 * DAY), gone);
    expect(res.status).toBe('deleted');
    expect(res.summary?.tables).toMatchObject({
      provider_credentials: 1,
      data_exports: 1,
      usage_events: 1,
      'takedown_requests:anonymised': 1,
    });
    expect(await db.providerCredential.count({ where: { organisationId: gone } })).toBe(0);
    expect(await db.dataExport.count({ where: { organisationId: gone } })).toBe(0);
    expect(await db.businessPurge.count({ where: { organisationId: gone } })).toBe(1);
    const kept = await db.takedownRequest.findUniqueOrThrow({ where: { id: takedown.id } });
    expect(kept).toMatchObject({
      requester: null,
      publicationId: null,
      category: 'privacy',
      source: 'policy_mailbox',
      organisationId: gone,
    });

    await db.takedownRequest.delete({ where: { id: takedown.id } });
    await db.businessPurge.deleteMany({ where: { organisationId: gone } });
    await db.organisationPurge.deleteMany({ where: { organisationId: gone } });
    await db.systemFlag.deleteMany({ where: { key: { contains: gone } } });
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
