import { QuotaExceededError } from '@/lib/errors';
import { studioModes } from '@/lib/mode';
import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  assertLocalBusinesses,
  businessesAreLocal,
  selectBusinessDirectory,
} from '@/lib/studio/core/select';
import { createBusiness, createBusinessInput } from '@/lib/studio/services/businesses';

// GET /api/studio/businesses — the active organisation's businesses: 200 { data: [{ id, name,
// domain? }] }. Phase 18 §2.11: in standalone mode (STUDIO_BUSINESSES=local) they are
// studio.businesses; in core mode they come from PostMind Core, which has no list-businesses
// endpoint yet, so it answers 501 not_implemented "waiting for Core list-businesses (…)".
// `local` tells the UI whether businesses can be added here (true) or live in PostMind (false).
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ deps, tenant }) => {
  const modes = deps.modes ?? studioModes();
  const directory = selectBusinessDirectory(modes, deps.db, deps.core?.businesses);
  const businesses = await directory.listBusinesses(tenant.organisationId);
  return {
    body: {
      data: businesses.map((b) => ({
        id: b.id,
        name: b.name,
        ...(b.domain && { domain: b.domain }),
      })),
      local: businessesAreLocal(modes),
    },
  };
});

// POST /api/studio/businesses { name, domain? } → 201 { business }. 409 on a duplicate name,
// 403 quota_exceeded { resource: 'businesses', limit } past the plan's business limit (§P.1,
// EntitlementsReader limits.businesses: 1 / 3 / 10 / custom), audited studio.business.create_refused.
export const POST = withStudioRoute(
  StudioCapability.BusinessManage,
  async ({ req, deps, tenant, audit }) => {
    assertLocalBusinesses(deps.modes ?? studioModes());
    const input = await parseBody(req, createBusinessInput);
    let business;
    try {
      business = await createBusiness(
        { db: deps.db, entitlements: deps.entitlements },
        { organisationId: tenant.organisationId, userId: tenant.userId },
        input,
      );
    } catch (err) {
      // §P.1: over the plan's business limit — refused (quota_exceeded opens the upgrade dialog)
      // and audited. Existing businesses keep working after a downgrade; only creates are capped.
      if (err instanceof QuotaExceededError)
        audit(
          'studio.business.create_refused',
          { type: 'business', id: 'new' },
          {
            reason: 'plan_limit',
            limit: err.details?.limit,
          },
        );
      throw err;
    }
    audit('studio.business.create', { type: 'business', id: business.id }, { name: business.name });
    return { status: 201, body: { business } };
  },
);
