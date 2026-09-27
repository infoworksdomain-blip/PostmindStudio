import { ConfigurationError } from '../../errors';
import type { ProviderAdapter, ProviderCapability } from './interface';

// BACKLOG 2.3. Holds every configured adapter. Adapters are only registered when their
// credentials exist, so the router naturally skips providers that aren't set up.

export interface ProviderRegistry {
  getAdapter(providerId: string): ProviderAdapter;
  findAdapter(providerId: string): ProviderAdapter | undefined;
  getAdaptersByCapability(capability: ProviderCapability): ProviderAdapter[];
  list(): ProviderAdapter[];
}

export function createProviderRegistry(adapters: readonly ProviderAdapter[]): ProviderRegistry {
  const byId = new Map<string, ProviderAdapter>();
  for (const adapter of adapters) {
    if (byId.has(adapter.providerId)) {
      throw new ConfigurationError(`Provider ${adapter.providerId} registered twice`);
    }
    byId.set(adapter.providerId, adapter);
  }

  return {
    getAdapter(providerId) {
      const adapter = byId.get(providerId);
      if (!adapter) throw new ConfigurationError(`Provider ${providerId} is not configured`);
      return adapter;
    },
    findAdapter(providerId) {
      return byId.get(providerId);
    },
    getAdaptersByCapability(capability) {
      return [...byId.values()].filter((a) => a.capabilities.includes(capability));
    },
    list() {
      return [...byId.values()];
    },
  };
}
