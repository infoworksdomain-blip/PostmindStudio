import type { TenantContext } from '../../tenant';

// Local UI development without PostMind Core: STUDIO_DEV_TENANT="<organisationId>:<userId>"
// makes every API request run as that tenant with every Studio capability. It is honoured ONLY
// when NODE_ENV is "development" (next dev); production builds (NODE_ENV=production) and tests
// ignore it, so it can never bypass JWT verification in a deployed service.

export const DEV_CAPABILITIES = ['studio:*'];

export function devTenantFromEnv(
  env: Record<string, string | undefined> = process.env,
): TenantContext | undefined {
  if (env.NODE_ENV !== 'development') return undefined;
  const raw = env.STUDIO_DEV_TENANT?.trim();
  if (!raw) return undefined;
  const [organisationId, userId] = raw.split(':').map((s) => s.trim());
  if (!organisationId || !userId) return undefined;
  return {
    userId,
    organisationId,
    organisation: { id: organisationId, name: 'Local development', planTier: 'PLUS' },
    memberships: [{ organisationId, role: 'owner' }],
    capabilities: DEV_CAPABILITIES,
  };
}
