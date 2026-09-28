import { describe, expect, it, vi } from 'vitest';
import type { KillSwitchStatus } from '../kill-switch';
import { createCircuitBreaker } from './circuit-breaker';
import { createProviderRegistry } from './registry';
import { routeProvider, type RouteInput } from './router';
import { StubAdapter } from './test-adapter';

// Phase 15 Track C router behaviour: the OpenAI text / transcription fallbacks (15.C1), the
// Storyblocks music fallback (15.C2), STOCK_FOOTAGE adapters, and ordered preferences (15.C4).

function deps(adapters: StubAdapter[]) {
  return {
    registry: createProviderRegistry(adapters),
    breaker: createCircuitBreaker(() => 0),
    killSwitch: { check: vi.fn(async (): Promise<KillSwitchStatus> => ({ killed: false })) },
    budget: { hasBudget: async () => true },
    now: () => 0,
  };
}

async function openBreaker(d: ReturnType<typeof deps>, providerId: string) {
  for (let i = 0; i < 5; i += 1) await d.breaker.recordFailure(providerId);
}

const text: RouteInput = {
  need: { kind: 'capability', capability: 'text_generation' },
  planTier: 'STANDARD',
  organisationId: 'org-1',
  request: { capability: 'text_generation', organisationId: 'org-1', system: 's', prompt: 'p' },
};

describe('Phase 15 Track C routing', () => {
  it('15.C1: Claude breaker open → the OpenAI text fallback', async () => {
    const d = deps([
      new StubAdapter('anthropic', ['text_generation']),
      new StubAdapter('openai', ['text_to_image', 'embedding', 'text_generation', 'transcription']),
    ]);
    expect((await routeProvider(text, d)).providerId).toBe('anthropic');
    await openBreaker(d, 'anthropic');
    const decision = await routeProvider(text, d);
    expect(decision.providerId).toBe('openai');
    expect(decision.candidates[0]).toEqual({ providerId: 'anthropic', skipped: 'circuit_open' });
  });

  it('15.C1: AssemblyAI breaker open → OpenAI transcription', async () => {
    const d = deps([
      new StubAdapter('assemblyai', ['transcription']),
      new StubAdapter('openai', ['transcription']),
    ]);
    await openBreaker(d, 'assemblyai');
    const decision = await routeProvider(
      {
        need: { kind: 'capability', capability: 'transcription' },
        planTier: 'BASIC',
        organisationId: 'org-1',
        request: {
          capability: 'transcription',
          organisationId: 'org-1',
          mediaUrl: 'https://assets.example/a.mp3',
          durationSec: 10,
        },
      },
      d,
    );
    expect(decision.providerId).toBe('openai');
  });

  it('15.C2: ElevenLabs Music breaker open → Storyblocks music', async () => {
    const d = deps([
      new StubAdapter('elevenlabs-music', ['music']),
      new StubAdapter('storyblocks-music', ['music']),
    ]);
    await openBreaker(d, 'elevenlabs-music');
    const decision = await routeProvider(
      {
        need: { kind: 'capability', capability: 'music' },
        planTier: 'STANDARD',
        organisationId: 'org-1',
        request: { capability: 'music', organisationId: 'org-1', prompt: 'calm', durationSec: 30 },
      },
      d,
    );
    expect(decision.providerId).toBe('storyblocks-music');
  });

  const stock = (extra: Partial<RouteInput> = {}): RouteInput => ({
    need: { kind: 'shot', visualTreatment: 'STOCK_FOOTAGE', durationSec: 4 },
    planTier: 'BASIC',
    organisationId: 'org-1',
    request: {
      capability: 'stock_footage',
      organisationId: 'org-1',
      query: 'bakery counter',
      durationSec: 4,
      aspectRatio: '9:16',
    },
    ...extra,
  });

  it('STOCK_FOOTAGE: Storyblocks video first, Pexels video when Storyblocks is down', async () => {
    const d = deps([
      new StubAdapter('storyblocks-video', ['stock_footage']),
      new StubAdapter('pexels-video', ['stock_footage']),
    ]);
    expect((await routeProvider(stock(), d)).providerId).toBe('storyblocks-video');
    await openBreaker(d, 'storyblocks-video');
    expect((await routeProvider(stock(), d)).providerId).toBe('pexels-video');
  });

  it('15.C4: an ordered preference list reorders candidates but never adds one', async () => {
    const d = deps([
      new StubAdapter('storyblocks-video', ['stock_footage']),
      new StubAdapter('pexels-video', ['stock_footage']),
    ]);
    const preferred = await routeProvider(
      stock({ preferredProviderId: ['unknown', 'pexels-video'] }),
      d,
    );
    expect(preferred.providerId).toBe('pexels-video');
    expect(preferred.candidates).toEqual([{ providerId: 'pexels-video' }]);
  });
});
