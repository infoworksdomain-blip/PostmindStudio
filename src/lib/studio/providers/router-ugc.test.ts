import { describe, expect, it, vi } from 'vitest';
import { NoProviderAvailableError } from '../../errors';
import type { KillSwitchStatus } from '../kill-switch';
import { createCircuitBreaker } from './circuit-breaker';
import type { ActorVideoRequest } from './interface';
import { KlingAdapter } from './kling';
import { createProviderRegistry } from './registry';
import { ACTOR_CANDIDATES, planCandidates, routeProvider, type RouteInput } from './router';
import { VeoAdapter } from './veo';

// BACKLOG 21.4 — UGC_ACTOR routing: Veo first, then Kling only when its actor mode is on, on every
// tier (UGC is open to every active subscriber, operator decision 2026-10-04).

const request: ActorVideoRequest = {
  capability: 'actor_video',
  organisationId: 'org-1',
  projectId: 'p-1',
  prompt: 'creator review',
  spokenLine: 'I use it every day.',
  languageCode: 'en-GB',
  durationSec: 6,
  aspectRatio: '9:16',
};

const input = (planTier: RouteInput['planTier']): RouteInput => ({
  need: { kind: 'shot', visualTreatment: 'UGC_ACTOR', durationSec: 6 },
  planTier,
  organisationId: 'org-1',
  projectId: 'p-1',
  request,
});

function deps(adapters: Array<VeoAdapter | KlingAdapter>, killed: string[] = []) {
  return {
    registry: createProviderRegistry(adapters),
    breaker: createCircuitBreaker(() => 0),
    killSwitch: {
      check: vi.fn(async ({ providerId }: { providerId?: string }): Promise<KillSwitchStatus> =>
        providerId && killed.includes(providerId)
          ? { killed: true, level: 'provider', key: `studio.disabledProvider.${providerId}` }
          : { killed: false },
      ),
    },
    budget: { hasBudget: async () => true },
    now: () => 0,
  };
}

const veo = () => new VeoAdapter({ apiKey: 'k', usdToGbpRate: 0.75 });
const kling = (actorVideo: boolean) =>
  new KlingAdapter({
    credentials: { kind: 'api_key', apiKey: 'k' },
    usdToGbpRate: 0.75,
    ...(actorVideo && { actorVideo: true }),
  });

describe('UGC_ACTOR routing (21.4)', () => {
  it.each(['BASIC', 'STANDARD', 'PLUS', 'ENTERPRISE'] as const)('%s: veo then kling', (tier) => {
    const ids = ['veo', 'kling'];
    expect(ACTOR_CANDIDATES).toEqual(ids);
    expect(
      planCandidates({ kind: 'shot', visualTreatment: 'UGC_ACTOR', durationSec: 6 }, tier),
    ).toEqual({ capability: 'actor_video', providerIds: ids });
  });

  it('routes to Veo first', async () => {
    const decision = await routeProvider(input('STANDARD'), deps([veo(), kling(true)]));
    expect(decision.providerId).toBe('veo');
    expect(decision.capability).toBe('actor_video');
  });

  it('fails over to Kling only when its actor mode is on', async () => {
    const on = await routeProvider(input('PLUS'), deps([veo(), kling(true)], ['veo']));
    expect(on.providerId).toBe('kling');
    await expect(
      routeProvider(input('PLUS'), deps([veo(), kling(false)], ['veo'])),
    ).rejects.toBeInstanceOf(NoProviderAvailableError);
  });

  it('routes a legacy BASIC organisation too (no tier gate)', async () => {
    expect((await routeProvider(input('BASIC'), deps([veo()]))).providerId).toBe('veo');
  });
});
