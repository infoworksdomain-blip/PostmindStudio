import { describe, expect, it, vi } from 'vitest';
import { CostCapPausedError } from '../../errors';
import type { KillSwitchStatus } from '../kill-switch';
import { createCircuitBreaker } from './circuit-breaker';
import { createProviderRegistry } from './registry';
import { routeProvider, type BudgetChecker, type RouteInput } from './router';
import { StubAdapter } from './test-adapter';

// Spec 12.5: the router refuses every provider call while a cost cap pauses generation.

const input: RouteInput = {
  need: { kind: 'capability', capability: 'tts' },
  planTier: 'PLUS',
  organisationId: 'org-1',
  projectId: 'proj-1',
  request: {
    capability: 'tts',
    organisationId: 'org-1',
    projectId: 'proj-1',
    text: 'hi',
    voiceId: 'v',
  },
};

function deps(budget: BudgetChecker) {
  const elevenlabs = new StubAdapter('elevenlabs', ['tts'], { costPence: 3 });
  return {
    elevenlabs,
    deps: {
      registry: createProviderRegistry([elevenlabs]),
      breaker: createCircuitBreaker(() => 0),
      killSwitch: { check: vi.fn(async (): Promise<KillSwitchStatus> => ({ killed: false })) },
      budget,
      now: () => 0,
    },
  };
}

describe('routeProvider cost-cap pause', () => {
  it('checks the pause once, with the plan tier, before any candidate', async () => {
    const assertNotPaused = vi.fn(async () => undefined);
    const hasBudget = vi.fn(async () => true);
    const { deps: d } = deps({ hasBudget, assertNotPaused });
    const decision = await routeProvider(input, d);
    expect(decision.providerId).toBe('elevenlabs');
    expect(assertNotPaused).toHaveBeenCalledOnce();
    expect(assertNotPaused).toHaveBeenCalledWith({
      organisationId: 'org-1',
      projectId: 'proj-1',
      planTier: 'PLUS',
    });
  });

  it('propagates the pause (not NoProviderAvailable) and never consults candidates', async () => {
    const hasBudget = vi.fn(async () => true);
    const { deps: d } = deps({
      hasBudget,
      assertNotPaused: async () => {
        throw new CostCapPausedError('org_daily', 'organisation daily cost cap reached');
      },
    });
    await expect(routeProvider(input, d)).rejects.toBeInstanceOf(CostCapPausedError);
    expect(hasBudget).not.toHaveBeenCalled();
    expect(d.killSwitch.check).not.toHaveBeenCalled();
  });

  it('works with budget checkers that have no pause support', async () => {
    const { deps: d } = deps({ hasBudget: async () => true });
    await expect(routeProvider(input, d)).resolves.toMatchObject({ providerId: 'elevenlabs' });
  });
});
