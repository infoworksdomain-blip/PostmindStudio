import { NotImplementedError } from '../errors';
import type { IdentityProvider } from './provider';

// Phase 18 §2.2 standalone mode — Better Auth sessions. Track 0 stub: milestone A1 replaces it.

export async function createStandaloneIdentityProviderFromEnv(): Promise<IdentityProvider> {
  throw new NotImplementedError('Standalone identity (Better Auth) lands in Phase 18 milestone A1');
}
