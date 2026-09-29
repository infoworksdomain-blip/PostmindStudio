import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError, NoOrganisationError, UnauthorizedError } from '../errors';
import { StudioCapability as C, hasCapability } from '../rbac';
import { createStubEntitlementsReader } from '../studio/billing/entitlements-reader';
import {
  createStandaloneIdentityProvider,
  ORGANISATION_HEADER,
  type AuthSessionView,
  type IdentityRecord,
  type StandaloneIdentityDeps,
} from './standalone';

const ORIGIN = 'https://studio.test';
const NOW = Date.parse('2026-09-29T12:00:00Z');

function record(overrides: Partial<IdentityRecord> = {}): IdentityRecord {
  return {
    userId: 'u1',
    platformRole: 'user',
    banned: false,
    banExpires: null,
    twoFactorEnabled: false,
    deletedAt: null,
    memberships: [
      { organisationId: 'org-a', organisationName: 'Acme', role: 'owner', joinedAt: new Date(1) },
      { organisationId: 'org-b', organisationName: 'Beta', role: 'viewer', joinedAt: new Date(2) },
    ],
    ...overrides,
  };
}

function session(overrides: Partial<AuthSessionView['session']> = {}): AuthSessionView {
  return {
    session: { id: 's1', userId: 'u1', activeOrganizationId: 'org-a', ...overrides },
    user: { id: 'u1' },
  };
}

function setup(
  opts: {
    view?: AuthSessionView | null;
    rec?: IdentityRecord | null;
    deps?: Partial<StandaloneIdentityDeps>;
  } = {},
) {
  const load = vi.fn(async () => (opts.rec === undefined ? record() : opts.rec));
  const getSession = vi.fn(async () => (opts.view === undefined ? session() : opts.view));
  const provider = createStandaloneIdentityProvider({
    getSession,
    store: { load },
    entitlements: createStubEntitlementsReader(),
    appOrigin: ORIGIN,
    now: () => NOW,
    ...opts.deps,
  });
  return { provider, load, getSession };
}

function req(method = 'GET', headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/studio/projects`, { method, headers });
}

describe('StandaloneIdentityProvider (Phase 18 §2.2)', () => {
  it('401 without a session', async () => {
    const { provider } = setup({ view: null });
    await expect(provider.resolve(req())).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('builds the tenant from the active organisation and the member role', async () => {
    const { provider } = setup();
    const tenant = await provider.resolve(req());
    expect(tenant).toMatchObject({
      userId: 'u1',
      organisationId: 'org-a',
      organisation: { id: 'org-a', name: 'Acme', planTier: 'BASIC' },
      role: 'owner',
      platformRole: 'user',
      sessionId: 's1',
      access: 'none',
      memberships: [
        { organisationId: 'org-a', role: 'owner' },
        { organisationId: 'org-b', role: 'viewer' },
      ],
    });
    expect(hasCapability(tenant, C.BillingManage)).toBe(true);
    expect(tenant.impersonatorUserId).toBeUndefined();
  });

  it('switches organisation by header only for members', async () => {
    const { provider } = setup();
    const b = await provider.resolve(req('GET', { [ORGANISATION_HEADER]: 'org-b' }));
    expect(b.organisationId).toBe('org-b');
    expect(hasCapability(b, C.ProjectWrite)).toBe(false);
    await expect(
      provider.resolve(req('GET', { [ORGANISATION_HEADER]: 'org-evil' })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('403 no_organisation when the user belongs to none', async () => {
    const { provider } = setup({ rec: record({ memberships: [] }) });
    const err = await provider.resolve(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoOrganisationError);
    expect((err as NoOrganisationError).code).toBe('no_organisation');
  });

  it('falls back to the oldest membership when the active organisation is gone', async () => {
    const { provider } = setup({ view: session({ activeOrganizationId: 'org-left' }) });
    expect((await provider.resolve(req())).organisationId).toBe('org-a');
  });

  it('refuses a cookie write from another site, and one with no Origin or fetch metadata', async () => {
    const { provider } = setup();
    await expect(
      provider.resolve(req('POST', { origin: 'https://evil.example' })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(provider.resolve(req('DELETE'))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(provider.resolve(req('POST', { origin: ORIGIN }))).resolves.toMatchObject({
      organisationId: 'org-a',
    });
    await expect(
      provider.resolve(req('PATCH', { 'sec-fetch-site': 'same-origin' })),
    ).resolves.toBeDefined();
  });

  it('401 for a banned (unexpired ban) or deleted user; an expired ban is lifted', async () => {
    await expect(
      setup({ rec: record({ banned: true }) }).provider.resolve(req()),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(
      setup({ rec: record({ banned: true, banExpires: new Date(NOW + 1000) }) }).provider.resolve(
        req(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(
      setup({ rec: record({ banned: true, banExpires: new Date(NOW - 1000) }) }).provider.resolve(
        req(),
      ),
    ).resolves.toBeDefined();
    await expect(
      setup({ rec: record({ deletedAt: new Date(NOW) }) }).provider.resolve(req()),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(setup({ rec: null }).provider.resolve(req())).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('gives staff admin capabilities only with 2FA (§2.5)', async () => {
    const without = await setup({ rec: record({ platformRole: 'staff' }) }).provider.resolve(req());
    expect(without.platformRole).toBe('staff');
    expect(hasCapability(without, C.AdminLibrary)).toBe(false);
    const withTotp = await setup({
      rec: record({ platformRole: 'superadmin', twoFactorEnabled: true }),
    }).provider.resolve(req());
    expect(hasCapability(withTotp, C.AdminKillSwitchWrite)).toBe(true);
  });

  it('refuses impersonation while it is disabled, and writes while it is read-only', async () => {
    const view = session({ impersonatedBy: 'staff-1' });
    await expect(setup({ view }).provider.resolve(req())).rejects.toBeInstanceOf(UnauthorizedError);
    const readOnly = setup({
      view,
      deps: { impersonation: { enabled: true, allowWrites: false } },
    });
    await expect(readOnly.provider.resolve(req())).resolves.toMatchObject({
      impersonatorUserId: 'staff-1',
    });
    await expect(readOnly.provider.resolve(req('POST', { origin: ORIGIN }))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('caches per session and organisation for 30 s; invalidate(userId) drops it', async () => {
    let t = NOW;
    const { provider, load } = setup({ deps: { now: () => t } });
    await provider.resolve(req());
    await provider.resolve(req());
    expect(load).toHaveBeenCalledTimes(1);
    await provider.resolve(req('GET', { [ORGANISATION_HEADER]: 'org-b' }));
    expect(load).toHaveBeenCalledTimes(2);
    provider.invalidate('u1');
    await provider.resolve(req());
    expect(load).toHaveBeenCalledTimes(3);
    t += 30_001;
    await provider.resolve(req());
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('expires a session 30 days after sign-in even while it is used (§2.3)', async () => {
    const fresh = setup({ view: session({ createdAt: new Date(NOW - 29 * 86_400_000) }) });
    await expect(fresh.provider.resolve(req())).resolves.toBeDefined();
    const old = setup({
      view: session({ createdAt: new Date(NOW - 31 * 86_400_000).toISOString() }),
    });
    await expect(old.provider.resolve(req())).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('reads the session on every request, so a revoked session is never served from cache', async () => {
    const { provider, getSession } = setup();
    await provider.resolve(req());
    getSession.mockResolvedValueOnce(null);
    await expect(provider.resolve(req())).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
