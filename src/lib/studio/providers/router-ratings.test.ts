import { describe, expect, it, vi } from 'vitest';
import type { KillSwitchStatus } from '../kill-switch';
import { rateProviders, scoresOf, type AssetEvidence } from '../services/provider-ratings';
import { createCircuitBreaker } from './circuit-breaker';
import { createProviderRegistry } from './registry';
import { routeProvider, type RouteInput } from './router';
import { StubAdapter } from './test-adapter';

// P7: per-business provider ratings reorder a tier's candidates. STANDARD AI_CLIP is
// [luma, runway, kling] in the spec; a business whose Runway shots rate higher tries Runway first.

function deps(adapters: StubAdapter[]) {
  return {
    registry: createProviderRegistry(adapters),
    breaker: createCircuitBreaker(() => 0),
    killSwitch: { check: vi.fn(async (): Promise<KillSwitchStatus> => ({ killed: false })) },
    budget: { hasBudget: async () => true },
    now: () => 0,
  };
}

const clip: RouteInput = {
  need: { kind: 'shot', visualTreatment: 'AI_CLIP', durationSec: 5 },
  planTier: 'STANDARD',
  organisationId: 'org-1',
  request: {
    capability: 'text_to_video',
    organisationId: 'org-1',
    prompt: 'p',
    durationSec: 5,
    aspectRatio: '9:16',
  },
};

const outputs = (provider: string, n: number, replaced: number): AssetEvidence[] =>
  Array.from({ length: n }, (_, i) => [
    {
      id: `${provider}-${i}`,
      shotId: `${provider}-shot-${i}`,
      scriptId: 's',
      projectId: 'p',
      visualTreatment: 'AI_CLIP' as const,
      source: `${provider}:m`,
      createdAt: new Date(0),
    },
    ...(i < replaced
      ? [
          {
            id: `swap-${provider}-${i}`,
            shotId: `${provider}-shot-${i}`,
            scriptId: 's',
            projectId: 'p',
            visualTreatment: 'AI_CLIP' as const,
            source: 'upload:x',
            createdAt: new Date(1000),
          },
        ]
      : []),
  ]).flat();

describe('router with provider ratings (P7)', () => {
  const adapters = () => [
    new StubAdapter('luma', ['text_to_video']),
    new StubAdapter('runway', ['text_to_video']),
    new StubAdapter('kling', ['text_to_video']),
  ];

  it('keeps the spec order without ratings', async () => {
    // 20.23: seedance → veo → runway → luma → kling; Seedance and Veo are not registered here.
    expect((await routeProvider(clip, deps(adapters()))).providerId).toBe('runway');
  });

  it('tries the higher-rated Luma before Runway', async () => {
    const scores = scoresOf(
      rateProviders({
        assets: [...outputs('runway', 6, 4), ...outputs('luma', 6, 0)],
        decisions: [],
        renders: [],
      }),
    );
    expect(scores.luma).toBeGreaterThan(scores.runway ?? 0);
    const decision = await routeProvider({ ...clip, providerScores: scores }, deps(adapters()));
    expect(decision.providerId).toBe('luma');
  });

  it('an explicit preference still beats a rating, and ratings never add providers', async () => {
    const decision = await routeProvider(
      { ...clip, preferredProviderId: 'kling', providerScores: { runway: 1, veo: 1 } },
      deps(adapters()),
    );
    expect(decision.providerId).toBe('kling');
    expect(decision.candidates.map((c) => c.providerId)).not.toContain('veo');
  });
});
