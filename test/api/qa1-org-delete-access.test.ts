import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as orgRoute from '../../src/app/api/studio/org/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import type { IdentityProvider } from '../../src/lib/identity/provider';
import type { TenantContext } from '../../src/lib/tenant';
import { call, installApi } from '../helpers/api-harness';

// QA 1: deleting an organisation says "everyone loses access immediately", but the tenant
// context of each member is cached for 30 s (identity/standalone.ts), so the deleted organisation
// stayed usable. The delete must drop every member's cached context.

vi.mock('../../src/lib/auth/reauth', () => ({
  reauthenticateRequest: vi.fn(async () => undefined),
}));

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('deleting an organisation drops its members’ cached access', () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const run = randomUUID().slice(0, 8);
  const orgId = `qa1-del-${run}`;
  const owner = `qa1-del-owner-${run}`;
  const mate = `qa1-del-mate-${run}`;
  const invalidate = vi.fn<(userId: string) => void>();
  const identity: IdentityProvider = {
    mode: 'standalone',
    resolve: vi.fn(),
    invalidate,
  };

  const tenant: TenantContext = {
    userId: owner,
    organisationId: orgId,
    organisation: { id: orgId },
    memberships: [{ organisationId: orgId, role: 'owner' }],
    capabilities: ['studio:project:read', 'studio:org:delete'],
    role: 'owner',
    platformRole: 'user',
  };

  beforeEach(() => {
    invalidate.mockClear();
    installApi(db, { owner: tenant }).deps.identity = identity;
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.organization.deleteMany({ where: { id: orgId } });
    await db.user.deleteMany({ where: { id: { in: [owner, mate] } } });
    await db.$disconnect();
  });

  it('invalidates the owner and every other member after the delete', async () => {
    for (const id of [owner, mate]) {
      await db.user.create({
        data: { id, name: id, email: `${id}@example.test`, emailVerified: true },
      });
    }
    await db.organization.create({ data: { id: orgId, name: 'Bakery QA', slug: `qa1-${run}` } });
    for (const [userId, role] of [
      [owner, 'owner'],
      [mate, 'creator'],
    ] as const) {
      await db.member.create({
        data: { id: randomUUID(), organizationId: orgId, userId, role },
      });
    }
    const res = await call(orgRoute.DELETE, {
      method: 'DELETE',
      token: 'owner',
      body: { confirmName: 'Bakery QA', password: 'x' },
    });
    expect(res.status).toBe(200);
    expect(invalidate.mock.calls.map((c) => c[0]).sort()).toEqual([mate, owner].sort());
  });
});
