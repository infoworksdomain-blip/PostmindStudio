import { describe, expect, it, vi } from 'vitest';
import { BillingRequiredError, PlanRequiredError } from '../../errors';
import type { TenantContext } from '../../tenant';
import { accessDecision, assertAccess, billingGate, studioPath } from './access-gate';
import {
  NO_PLAN_ENTITLEMENTS,
  type Entitlements,
  type EntitlementsReader,
} from './entitlements-reader';

const api = (path: string) => `/api/studio${path}`;

describe('accessDecision (§P.3 access gate)', () => {
  it('full access blocks nothing; reads are never blocked', () => {
    expect(accessDecision('full', 'POST', api('/projects/p1/generate'))).toEqual({ allowed: true });
    expect(accessDecision(undefined, 'POST', api('/publications'))).toEqual({ allowed: true });
    for (const access of ['none', 'read_only'] as const) {
      for (const method of ['GET', 'HEAD', 'OPTIONS', 'get'])
        expect(accessDecision(access, method, api('/projects/p1/generate')).allowed).toBe(true);
    }
  });

  describe('access none (never subscribed): spend routes → 402 plan_required', () => {
    const blocked = [
      '/projects/p1/generate',
      '/content-plans',
      '/content-plans/c1/generate',
      '/content-plans/c1/redraft',
      '/content-plans/c1/items/i1/regenerate',
      '/projects/p1/auto-populate',
      '/projects/p1/auto-publish',
      '/projects/p1/auto-publish/retry',
      '/projects/p1/caption-suggestions',
      '/scripts/s1/regenerate',
      '/shots/s1/regenerate',
      '/renders/r1/rerender',
      '/overlays/o1/preview',
      '/publications',
      '/publications/pub1/retry',
      '/businesses/b1/scan-website',
      '/businesses/b1/scans/schedule',
      '/image-library/generate',
      '/image-library/refresh',
      '/brand-kits/extract',
      '/voice-profiles',
      '/voice-profiles/v1/preview',
      '/uploads/u1/complete',
    ];
    for (const path of blocked)
      it(`POST ${path} is blocked`, () =>
        expect(accessDecision('none', 'POST', api(path))).toEqual({
          allowed: false,
          code: 'plan_required',
        }));

    const allowed = [
      '/projects',
      '/projects/p1',
      '/brand-kits',
      '/businesses',
      '/platform-connections/oauth-init',
      '/billing/checkout',
      '/onboarding',
      '/approval-workflows',
    ];
    for (const path of allowed)
      it(`set-up route ${path} is allowed`, () =>
        expect(accessDecision('none', 'POST', api(path)).allowed).toBe(true));
  });

  describe('access read_only: mutations → 402 billing_required except the allowlist', () => {
    const allowed = [
      '/billing/checkout',
      '/billing/portal',
      '/account/export',
      '/account/delete',
      '/org',
      '/organisations/switch',
      '/members/m1',
      '/invitations',
      '/notifications/n1/read',
      '/notifications/read-all',
      '/notification-preferences',
      '/renders/r1/download',
      '/feedback',
      '/admin/organisations/o1/entitlements',
    ];
    for (const path of allowed)
      it(`POST ${path} is allowed`, () =>
        expect(accessDecision('read_only', 'POST', api(path)).allowed).toBe(true));

    it('deletes are allowed (GDPR, clean-up)', () => {
      expect(accessDecision('read_only', 'DELETE', api('/projects/p1')).allowed).toBe(true);
    });

    for (const [method, path] of [
      ['POST', '/projects'],
      ['PATCH', '/projects/p1'],
      ['POST', '/projects/p1/generate'],
      ['POST', '/publications'],
      ['PUT', '/brand-kits/b1'],
      ['POST', '/businesses'],
    ] as const)
      it(`${method} ${path} is blocked`, () =>
        expect(accessDecision('read_only', method, api(path))).toEqual({
          allowed: false,
          code: 'billing_required',
        }));
  });

  it('studioPath strips the prefix only for /api/studio', () => {
    expect(studioPath('/api/studio')).toBe('/');
    expect(studioPath('/api/studio/billing')).toBe('/billing');
    expect(studioPath('/api/billing/stripe/webhook')).toBe('');
  });
});

const tenant = (overrides: Partial<TenantContext> = {}): TenantContext => ({
  userId: 'u1',
  organisationId: 'org-1',
  organisation: { id: 'org-1', planTier: 'PLUS' },
  memberships: [{ organisationId: 'org-1', role: 'owner' }],
  capabilities: [],
  ...overrides,
});

describe('assertAccess', () => {
  it('throws the 402 errors with the access in details', () => {
    expect(() =>
      assertAccess(tenant({ access: 'none' }), 'POST', api('/projects/p1/generate')),
    ).toThrow(PlanRequiredError);
    expect(() => assertAccess(tenant({ access: 'read_only' }), 'POST', api('/projects'))).toThrow(
      BillingRequiredError,
    );
    try {
      assertAccess(tenant({ access: 'read_only' }), 'POST', api('/projects'));
    } catch (err) {
      expect((err as BillingRequiredError).status).toBe(402);
      expect((err as BillingRequiredError).details).toMatchObject({ access: 'read_only' });
    }
  });
});

describe('billingGate (route.ts hook)', () => {
  const reader = (ent: Entitlements): EntitlementsReader => ({
    forOrganisation: vi.fn(async () => ent),
    invalidate: vi.fn(),
  });
  const req = (method: string, path: string) => ({ method, url: `https://s.test${api(path)}` });
  const active: Entitlements = {
    tier: 'STANDARD',
    access: 'full',
    source: 'stripe',
    limits: { seats: 5, businesses: 3, storageGb: 100 },
  };

  it('without a reader (tests) or in core mode the tenant is unchanged', async () => {
    const t = tenant();
    await expect(billingGate({ now: Date.now }, req('POST', '/publications'), t)).resolves.toBe(t);
    const r = reader(NO_PLAN_ENTITLEMENTS);
    await expect(
      billingGate(
        { entitlements: r, modes: { billing: 'core' }, now: Date.now },
        req('POST', '/publications'),
        t,
      ),
    ).resolves.toBe(t);
    expect(r.forOrganisation).not.toHaveBeenCalled();
  });

  it('sets the tier and access from entitlements (Core planTier ignored)', async () => {
    const out = await billingGate(
      { entitlements: reader(active), now: Date.now },
      req('POST', '/projects/p1/generate'),
      tenant(),
    );
    expect(out.organisation.planTier).toBe('STANDARD');
    expect(out.access).toBe('full');
  });

  it('an org without a plan cannot generate: 402 plan_required', async () => {
    await expect(
      billingGate(
        { entitlements: reader(NO_PLAN_ENTITLEMENTS), now: Date.now },
        req('POST', '/projects/p1/generate'),
        tenant(),
      ),
    ).rejects.toBeInstanceOf(PlanRequiredError);
  });

  it('an active beta ("Plus for 30 days") gives full access without a subscription', async () => {
    const now = Date.parse('2026-09-29T00:00:00Z');
    const betaPlans = {
      find: vi.fn(async () => ({ plusUntil: new Date(now + 86_400_000) })),
      invalidate: vi.fn(),
    };
    const out = await billingGate(
      { entitlements: reader(NO_PLAN_ENTITLEMENTS), betaPlans, now: () => now },
      req('POST', '/projects/p1/generate'),
      tenant(),
    );
    expect(out.access).toBe('full');
    betaPlans.find.mockResolvedValueOnce({ plusUntil: new Date(now - 1) });
    await expect(
      billingGate(
        { entitlements: reader(NO_PLAN_ENTITLEMENTS), betaPlans, now: () => now },
        req('POST', '/projects/p1/generate'),
        tenant(),
      ),
    ).rejects.toBeInstanceOf(PlanRequiredError);
  });
});
