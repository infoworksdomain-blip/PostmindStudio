import { describe, expect, it } from 'vitest';
import type { ProviderAdapter, ProviderRequest } from '../../providers/interface';
import { createProviderRegistry } from '../../providers/registry';
import { canMakeSilentHook } from './generate-hook-clip';

// 22.1 — only an actor adapter that accepts a SILENT request counts as an AI creator for hooks
// (Kling's actor path is dialogue-only), so a Kling-only setup uses the library fallback.

function actor(id: string, silentOk: boolean): ProviderAdapter {
  return {
    providerId: id,
    capabilities: ['actor_video'],
    supportsRequest: (r: ProviderRequest) =>
      r.capability === 'actor_video' && (silentOk || !r.silent),
    submit: async () => ({
      providerJobId: 'x',
      estimatedCostPence: 0,
      estimatedReadyAt: new Date(),
    }),
    poll: async () => ({ state: 'running' as const }),
    cancel: async () => undefined,
    healthCheck: async () => ({ healthy: true }),
  } as ProviderAdapter;
}

describe('canMakeSilentHook', () => {
  it('is true with Veo-like silent support', () => {
    expect(canMakeSilentHook(createProviderRegistry([actor('veo', true)]))).toBe(true);
  });
  it('is false with only a dialogue-only actor (Kling) or none', () => {
    expect(canMakeSilentHook(createProviderRegistry([actor('kling', false)]))).toBe(false);
    expect(canMakeSilentHook(createProviderRegistry([]))).toBe(false);
  });
});
