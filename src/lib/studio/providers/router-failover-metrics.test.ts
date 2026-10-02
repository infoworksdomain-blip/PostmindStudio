import { describe, expect, it, vi } from 'vitest';
import type { KillSwitchStatus } from '../kill-switch';
import { getMetrics } from '../observability/metrics';
import { createCircuitBreaker } from './circuit-breaker';
import { createProviderRegistry } from './registry';
import { routeProvider, type RouteInput } from './router';
import { StubAdapter } from './test-adapter';

// BACKLOG 17.4 — the router counts providers passed over for a run-time reason and providers
// selected; ops/prometheus/studio-alerts.yml (StudioProviderFailoverRateHigh) divides them.

async function value(name: string, labels: Record<string, string>): Promise<number> {
  const metric = getMetrics().registry.getSingleMetric(name);
  const data = await metric?.get();
  const hit = data?.values.find((v) => Object.entries(labels).every(([k, l]) => v.labels[k] === l));
  return hit?.value ?? 0;
}

const aiClip: RouteInput = {
  need: { kind: 'shot', visualTreatment: 'AI_CLIP', durationSec: 8 },
  planTier: 'STANDARD',
  organisationId: 'org-1',
  projectId: 'proj-1',
  request: {
    capability: 'text_to_video',
    organisationId: 'org-1',
    projectId: 'proj-1',
    prompt: 'p',
    durationSec: 8,
    aspectRatio: '9:16',
  },
};

describe('router failover metrics', () => {
  it('counts an open breaker as a pass-over and the fallback as selected', async () => {
    const breaker = createCircuitBreaker(() => 0);
    for (let i = 0; i < 5; i += 1) breaker.recordFailure('runway');
    const before = {
      passed: await value('studio_provider_passed_over_total', {
        provider: 'runway',
        reason: 'circuit_open',
      }),
      selected: await value('studio_provider_selected_total', { provider: 'luma' }),
    };
    const decision = await routeProvider(aiClip, {
      // AI_CLIP tries kling → veo → runway → luma (20.24); kling and veo are not registered here.
      registry: createProviderRegistry([
        new StubAdapter('runway', ['text_to_video']),
        new StubAdapter('luma', ['text_to_video']),
      ]),
      breaker,
      killSwitch: { check: vi.fn(async (): Promise<KillSwitchStatus> => ({ killed: false })) },
      budget: { hasBudget: async () => true },
      now: () => 0,
    });
    expect(decision.providerId).toBe('luma');
    expect(
      await value('studio_provider_passed_over_total', {
        provider: 'runway',
        reason: 'circuit_open',
      }),
    ).toBe(before.passed + 1);
    expect(await value('studio_provider_selected_total', { provider: 'luma' })).toBe(
      before.selected + 1,
    );
  });

  it('does not count a provider this deployment has not configured', async () => {
    const before = await value('studio_provider_passed_over_total', { provider: 'runway' });
    await routeProvider(aiClip, {
      registry: createProviderRegistry([new StubAdapter('luma', ['text_to_video'])]),
      breaker: createCircuitBreaker(() => 0),
      killSwitch: { check: vi.fn(async (): Promise<KillSwitchStatus> => ({ killed: false })) },
      budget: { hasBudget: async () => true },
      now: () => 0,
    });
    expect(await value('studio_provider_passed_over_total', { provider: 'runway' })).toBe(before);
  });
});
