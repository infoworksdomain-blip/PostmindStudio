import type { PrismaClient } from '@prisma/client';
import type { DataKeyProvider } from '../crypto/envelope';
import type { ProviderScope } from '../pipeline/deps';
import {
  byocEnabled,
  loadActiveKeys,
  onByocKeysChanged,
  projectByocMode,
} from '../services/provider-credentials';
import { minTierFor, tierAtLeast } from '../billing/catalogue';
import { toPlanTier } from '../services/catalog';
import type { ProviderKeyMap } from './byoc-providers';
import { buildAdaptersFromKeys } from './default-registry';
import type { ProviderAdapter } from './interface';
import { createProviderRegistry, type ProviderRegistry } from './registry';

// Phase 15 operator decision P1 (BYOC). Resolves the registry a provider call runs over
// (pipeline/deps.ts registryFor; provider-run.ts falls back to the platform registry on
// undefined). An organisation's own adapters replace the platform adapters with the same
// providerId; providers without an org key keep the platform adapter.
//
// undefined (= platform registry) when: STUDIO_BYOC_ENABLED is off; the project opted out
// (metadata.byoc = 'platform'); the project's recorded plan tier (metadata.planTier, set at
// generation) is not ENTERPRISE; or the organisation has no active keys. The tier is enforced
// at key creation too (services/provider-credentials.ts).
//
// Registries are cached per organisation for 60 s and dropped in-process when a key changes
// (other processes pick the change up when their cache entry expires).

type Env = Record<string, string | undefined>;

export const BYOC_REGISTRY_CACHE_MS = 60_000;

export interface ByocRegistryResolverDeps {
  db: PrismaClient;
  keys: DataKeyProvider;
  platformRegistry: ProviderRegistry;
  env?: Env;
  now?: () => number;
  /** Adapter factory; defaults to default-registry.ts buildAdaptersFromKeys. */
  buildAdapters?: (keys: ProviderKeyMap, env: Env) => ProviderAdapter[];
}

export type ByocRegistryResolver = ((
  scope: ProviderScope,
) => Promise<ProviderRegistry | undefined>) & {
  invalidate(organisationId?: string): void;
  dispose(): void;
};

/** The platform registry with `own` adapters replacing the same provider ids. */
export function overlayRegistry(
  platform: ProviderRegistry,
  own: readonly ProviderAdapter[],
): ProviderRegistry {
  const ownIds = new Set(own.map((a) => a.providerId));
  return createProviderRegistry([
    ...platform.list().filter((a) => !ownIds.has(a.providerId)),
    ...own,
  ]);
}

export function createByocRegistryResolver(deps: ByocRegistryResolverDeps): ByocRegistryResolver {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const build = deps.buildAdapters ?? buildAdaptersFromKeys;
  const cache = new Map<string, { at: number; registry: Promise<ProviderRegistry | undefined> }>();

  async function forOrganisation(organisationId: string) {
    const keys = await loadActiveKeys(deps.db, deps.keys, organisationId);
    if (Object.keys(keys).length === 0) return undefined;
    return overlayRegistry(deps.platformRegistry, build(keys, env));
  }

  async function projectAllows(scope: ProviderScope): Promise<boolean> {
    if (!scope.projectId) return true;
    const project = await deps.db.videoProject.findFirst({
      where: { id: scope.projectId, organisationId: scope.organisationId },
      select: { metadata: true },
    });
    if (!project) return true;
    if (projectByocMode(project.metadata) === 'platform') return false;
    const meta = project.metadata as Record<string, unknown> | null;
    const tier = meta && typeof meta.planTier === 'string' ? meta.planTier : undefined;
    return tier === undefined || tierAtLeast(toPlanTier(tier), minTierFor('byocProviderKeys'));
  }

  const resolve = async (scope: ProviderScope) => {
    if (!byocEnabled(env)) return undefined;
    if (!(await projectAllows(scope))) return undefined;
    const hit = cache.get(scope.organisationId);
    if (hit && now() - hit.at < BYOC_REGISTRY_CACHE_MS) return hit.registry;
    const registry = forOrganisation(scope.organisationId);
    cache.set(scope.organisationId, { at: now(), registry });
    // A failed lookup is not cached: the next call retries.
    registry.catch(() => cache.delete(scope.organisationId));
    return registry;
  };

  const unsubscribe = onByocKeysChanged((organisationId) => cache.delete(organisationId));
  return Object.assign(resolve, {
    invalidate(organisationId?: string) {
      if (organisationId) cache.delete(organisationId);
      else cache.clear();
    },
    dispose() {
      unsubscribe();
      cache.clear();
    },
  });
}
