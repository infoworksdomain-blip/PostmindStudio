import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioCapability } from '../../rbac';
import { PLATFORM_ORGANISATION_ID, type TenantContext } from '../../tenant';
import type { EntitlementsReader } from '../billing/entitlements-reader';
import { setApiDeps, type ApiDeps } from './context';
import { createMemoryIdempotencyStore } from './idempotency';
import { withStudioRoute } from './route';

// 20.10 — a superadmin with 2FA who belongs to no organisation (the first server's operator)
// saw "PostMind staff only" in the Admin Centre: every admin API answered 403 no_organisation.
// Admin routes now ask the identity provider for a staff-only context; workspace routes do not.

const staffOnly: TenantContext = {
  userId: 'staff-1',
  organisationId: PLATFORM_ORGANISATION_ID,
  organisation: { id: PLATFORM_ORGANISATION_ID, name: 'PostMind Studio staff' },
  memberships: [],
  capabilities: ['studio:admin:*'],
  platformRole: 'superadmin',
  access: 'full',
  staffOnly: true,
};

function install(resolveTenant: ApiDeps['resolveTenant'], entitlements?: EntitlementsReader) {
  setApiDeps({
    resolveTenant,
    idempotency: createMemoryIdempotencyStore(),
    audit: () => undefined,
    logger: pino({ level: 'silent' }),
    now: Date.now,
    ...(entitlements && { entitlements }),
  } as unknown as ApiDeps);
}

const next = { params: Promise.resolve({}) };

afterEach(() => setApiDeps(undefined));

describe('withStudioRoute and platform staff without an organisation', () => {
  it('asks for a staff-only context on admin routes and skips the plan gate', async () => {
    const resolveTenant = vi.fn(async () => staffOnly);
    // A plan lookup for the platform pseudo-organisation would find no plan and 402 a write.
    const forOrganisation = vi.fn(async () => {
      throw new Error('no entitlements lookup for a staff-only context');
    });
    install(resolveTenant, { forOrganisation } as unknown as EntitlementsReader);
    const handler = vi.fn(async ({ tenant }: { tenant: TenantContext }) => ({
      body: { organisationId: tenant.organisationId },
    }));
    const route = withStudioRoute(StudioCapability.AdminKillSwitchWrite, handler);
    const res = await route(
      new Request('http://studio.test/api/studio/admin/kill-switch', { method: 'PUT' }),
      next,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ organisationId: PLATFORM_ORGANISATION_ID });
    expect(resolveTenant).toHaveBeenCalledWith(expect.any(Request), {
      staffWithoutOrganisation: true,
    });
    expect(forOrganisation).not.toHaveBeenCalled();
  });

  it('never asks for it on workspace routes', async () => {
    const resolveTenant = vi.fn(async () => ({ ...staffOnly, capabilities: ['studio:*'] }));
    install(resolveTenant);
    const route = withStudioRoute(StudioCapability.ProjectRead, async () => ({ body: {} }));
    await route(new Request('http://studio.test/api/studio/projects'), next);
    expect(resolveTenant).toHaveBeenCalledWith(expect.any(Request), undefined);
  });

  it('still refuses a workspace capability to a staff-only context', async () => {
    install(async () => staffOnly);
    const route = withStudioRoute(StudioCapability.ProjectRead, async () => ({ body: {} }));
    // capability check: studio:admin:* does not cover studio:project:read.
    const res = await route(new Request('http://studio.test/api/studio/projects'), next);
    expect(res.status).toBe(403);
  });
});
