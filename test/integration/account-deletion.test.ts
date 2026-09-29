import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AuditAction } from '../../src/lib/audit-sink';
import { deleteAccount, purgeDeletedUsers } from '../../src/lib/auth/account-deletion';
import { ConflictError } from '../../src/lib/errors';
import { purgeOrganisation } from '../../src/lib/studio/services/organisation-purge';
import { cookiesFrom, createAuthHarness, signUpVerified } from '../helpers/auth-harness';

// Phase 18 §5.11 against Postgres: account deletion with the real Better Auth tables.

const hasDb = Boolean(process.env.DATABASE_URL);
const PASSWORD = 'correct horse battery staple 42';
const DAY = 86_400_000;

describe.skipIf(!hasDb)('account deletion (DB)', { timeout: 180_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const h = hasDb
    ? createAuthHarness(db)
    : (undefined as unknown as ReturnType<typeof createAuthHarness>);

  const createdOrgs: string[] = [];

  afterAll(async () => {
    // Other suites share this database and run the hard-delete job: leave no purge requests.
    await db?.organisationPurge.deleteMany({ where: { organisationId: { in: createdOrgs } } });
    await db?.$disconnect();
  });

  async function userWithOrg(label: string) {
    const email = h.email(label);
    let cookies = await signUpVerified(h, email, PASSWORD);
    const res = await h.call('/organization/create', {
      body: { name: `Org ${label}`, slug: `${label}-${randomUUID().slice(0, 8)}` },
      cookies,
    });
    cookies = cookiesFrom(res, cookies);
    const org = (await res.json()) as { id: string };
    createdOrgs.push(org.id);
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    return { email, cookies, orgId: org.id, userId: user.id };
  }

  const deps = (overrides: Partial<Parameters<typeof deleteAccount>[0]> = {}) => ({
    db,
    now: Date.now,
    purgeOrganisation: (id: string) => purgeOrganisation({ db, now: Date.now }, id),
    audit: async (r: Parameters<typeof h.audits.push>[0]) => {
      h.audits.push(r);
    },
    ...overrides,
  });

  it('deletes a sole-member organisation with the account and blocks sign-in', async () => {
    const { email, orgId, userId } = await userWithOrg('solo');
    const cancelBilling = vi.fn(async () => undefined);
    const result = await deleteAccount(deps({ cancelBilling }), userId);
    expect(result.deletedOrganisations).toEqual([orgId]);
    expect(cancelBilling).toHaveBeenCalledWith(orgId);
    expect(
      (await db.organization.findUniqueOrThrow({ where: { id: orgId } })).deletedAt,
    ).not.toBeNull();
    expect(
      await db.organisationPurge.findUnique({ where: { organisationId: orgId } }),
    ).not.toBeNull();
    // Remove the purge request at once: other suites run the hard-delete job on this database.
    await db.organisationPurge.deleteMany({ where: { organisationId: orgId } });
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).deletedAt).not.toBeNull();
    expect(await db.session.count({ where: { userId } })).toBe(0);
    const signIn = await h.call('/sign-in/email', { body: { email, password: PASSWORD } });
    expect(signIn.status).toBeGreaterThanOrEqual(400);
    expect(await db.session.count({ where: { userId } })).toBe(0);
    expect(h.audits.some((a) => a.action === AuditAction.AccountDeletionScheduled)).toBe(true);
  });

  it('refuses while the user is the only owner of an organisation with other members', async () => {
    const owner = await userWithOrg('owner');
    const other = await signUpVerified(h, h.email('member'), PASSWORD).then(() =>
      db.user.findFirstOrThrow({ where: { email: h.email('member') } }),
    );
    await db.member.create({
      data: { id: randomUUID(), organizationId: owner.orgId, userId: other.id, role: 'creator' },
    });
    const err = await deleteAccount(deps(), owner.userId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).details).toMatchObject({ reason: 'sole_owner' });
    expect((await db.user.findUniqueOrThrow({ where: { id: owner.userId } })).deletedAt).toBeNull();

    // The member can leave: their membership ends, the organisation stays.
    const left = await deleteAccount(deps(), other.id);
    expect(left.leftOrganisations).toEqual([owner.orgId]);
    expect(await db.member.count({ where: { organizationId: owner.orgId } })).toBe(1);
  });

  it('removes users after the 30-day grace, with their sessions and sign-in methods', async () => {
    const { userId } = await userWithOrg('grace');
    await deleteAccount(deps({ purgeOrganisation: async () => undefined }), userId);
    expect(await purgeDeletedUsers(db, Date.now())).toBe(0);
    await purgeDeletedUsers(db, Date.now() + 31 * DAY);
    expect(await db.user.findUnique({ where: { id: userId } })).toBeNull();
    expect(await db.account.count({ where: { userId } })).toBe(0);
  });
});
