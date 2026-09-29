import { organisationSlug, parseCreateOrganisation } from '@/lib/auth/organisations';
import { withSignedInRoute } from '@/lib/auth/session-route';

// Phase 18 §3 / Track A: POST /api/studio/organisations {name, country, defaultLocale}
// → 201 {organisation:{id,name,slug}}. Works for a signed-in user with no organisation yet; the
// new organisation becomes the session's active one (switching later: POST
// /api/auth/organization/set-active). Standalone mode only.

export const POST = withSignedInRoute(async ({ req, api, log }) => {
  const input = await parseCreateOrganisation(req);
  const created = await api.createOrganization(req.headers, {
    ...input,
    slug: organisationSlug(input.name),
  });
  log.info({ organisationId: created.organisation.id }, 'organisation created');
  return {
    status: 201,
    body: { organisation: created.organisation },
    setCookies: created.setCookies,
  };
});
