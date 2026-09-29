import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { collectExport } from '../../src/lib/studio/export/collect';
import { cookiesFrom, createAuthHarness, signUpVerified } from '../helpers/auth-harness';

// Phase 18 §5.11: the data export's `account` and `billing` groups, against the real tables.

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('export account and billing groups (DB)', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const h = hasDb
    ? createAuthHarness(db)
    : (undefined as unknown as ReturnType<typeof createAuthHarness>);

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('exports the organisation, memberships and my profile, never a secret', async () => {
    const email = h.email('export');
    let cookies = await signUpVerified(h, email, 'correct horse battery staple 42');
    const res = await h.call('/organization/create', {
      body: { name: 'Export Co', slug: `export-${randomUUID().slice(0, 8)}` },
      cookies,
    });
    cookies = cookiesFrom(res, cookies);
    const org = (await res.json()) as { id: string };
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    await db.subscription.create({
      data: {
        id: `sub_${randomUUID()}`,
        organisationId: org.id,
        stripeCustomerId: 'cus_1',
        status: 'active',
        lookupKey: 'studio_basic_monthly',
      },
    });

    const { tables } = await collectExport(db, org.id, ['account', 'billing'], {
      requestedByUserId: user.id,
    });
    expect(tables.organisation?.[0]).toMatchObject({ id: org.id, name: 'Export Co' });
    expect(tables.members).toEqual([expect.objectContaining({ userId: user.id, role: 'owner' })]);
    expect(tables.my_profile?.[0]).toMatchObject({ email, twoFactorEnabled: false });
    expect(tables.my_sign_in_methods).toEqual([
      expect.objectContaining({ providerId: 'credential' }),
    ]);
    expect(tables.my_sessions?.length).toBeGreaterThan(0);
    expect(tables.subscriptions).toEqual([expect.objectContaining({ status: 'active' })]);
    const text = JSON.stringify(tables);
    expect(text).not.toMatch(/"(password|token|secret|backupCodes)"/);
    expect(text).not.toContain('$argon2id$');
  });

  it('leaves the groups out unless asked', async () => {
    const { tables } = await collectExport(db, 'org-none', ['projects']);
    expect(tables.my_profile).toBeUndefined();
    expect(tables.subscriptions).toBeUndefined();
  });
});
