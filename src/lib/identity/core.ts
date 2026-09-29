import { coreTenantResolver, type TenantResolver } from '../tenant';
import type { IdentityProvider } from './provider';

// Phase 18 §2.2 core mode: today's tenant.ts resolver (Core's RS256 JWT + context), wrapped and
// otherwise unchanged.

export function createCoreIdentityProvider(
  resolver: TenantResolver = coreTenantResolver(),
): IdentityProvider {
  return {
    mode: 'core',
    resolve: (req) => resolver(req),
    invalidate: () => undefined,
  };
}
