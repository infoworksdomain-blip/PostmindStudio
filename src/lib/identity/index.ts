import { logger } from '../logger';
import { studioModes } from '../mode';
import type { IdentityProvider } from './provider';

export type { IdentityProvider, IdentityMode } from './provider';

// Phase 18 §2.2: the IdentityProvider for this process, chosen once from STUDIO_IDENTITY_MODE
// (STUDIO_MODE decides the default). Built lazily so core mode never loads Better Auth and
// standalone mode never needs POSTMIND_* env.

let provider: Promise<IdentityProvider> | undefined;

async function build(): Promise<IdentityProvider> {
  if (studioModes().identity === 'core') {
    const { createCoreIdentityProvider } = await import('./core');
    return createCoreIdentityProvider();
  }
  const { createStandaloneIdentityProviderFromEnv } = await import('./standalone');
  return createStandaloneIdentityProviderFromEnv();
}

export function getIdentityProvider(): Promise<IdentityProvider> {
  provider ??= build().catch((err: unknown) => {
    provider = undefined; // a failed build (bad config) is retried on the next request
    throw err;
  });
  return provider;
}

/**
 * Drop a user's cached tenant context (role change, ban, organisation deleted). ApiDeps carries no
 * identity provider in production, so routes reach the process's provider here; tests pass their own.
 */
export async function invalidateIdentity(
  userId: string,
  override?: IdentityProvider,
): Promise<void> {
  try {
    (override ?? (await getIdentityProvider())).invalidate(userId);
  } catch (err) {
    // Best effort: a cached context lives 30 s at most, so a provider that cannot be built here
    // must not fail the request that already changed the data.
    logger.warn({ err, userId }, 'could not drop the cached tenant context');
  }
}

/** Test hook: install a provider (pass undefined to reset). */
export function setIdentityProvider(next: IdentityProvider | undefined): void {
  provider = next ? Promise.resolve(next) : undefined;
}
