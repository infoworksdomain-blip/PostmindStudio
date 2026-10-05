import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../../../../test/helpers/memory-storage';
import { estimateVideoCostPence, type PricedCall } from '../cost/video-estimate';
import { AnthropicAdapter } from '../providers/anthropic';
import { AssemblyAiAdapter } from '../providers/assemblyai';
import { ElevenLabsMusicAdapter } from '../providers/elevenlabs-music';
import type { ProviderRequest } from '../providers/interface';
import { KlingAdapter } from '../providers/kling';
import { IMAGE_ESTIMATE_PENCE, OpenAIAdapter, type OpenAIClientLike } from '../providers/openai';
import { ShotstackAdapter } from '../providers/shotstack';
import { VeoAdapter } from '../providers/veo';
import { typicalUgcVideoCalls, ugcProjectBudgetPence, UGC_BUDGET_PENCE } from './cost';

// BACKLOG 21.4 — a typical 30 s UGC actor video at list price, priced by the adapters' own
// estimators, and the default budget arithmetic (ugc/cost.ts). Rates: production 0.75, cautious 0.79.

function price(rate: number) {
  const { storage } = memoryStorage();
  const all: Record<string, { estimateCostPence(r: ProviderRequest): number }> = {
    anthropic: new AnthropicAdapter({
      client: new Anthropic({ apiKey: 'offline' }),
      usdToGbpRate: rate,
    }),
    veo: new VeoAdapter({ apiKey: 'offline', usdToGbpRate: rate }),
    'veo-standard': new VeoAdapter({
      apiKey: 'offline',
      usdToGbpRate: rate,
      model: 'veo-3.1-generate-preview',
    }),
    kling: new KlingAdapter({
      credentials: { kind: 'api_key', apiKey: 'offline' },
      usdToGbpRate: rate,
      actorVideo: true,
    }),
    assemblyai: new AssemblyAiAdapter({ apiKey: 'offline', usdToGbpRate: rate }),
    'elevenlabs-music': new ElevenLabsMusicAdapter({
      apiKey: 'offline',
      storage,
      bucket: 'assets',
      usdToGbpRate: rate,
    }),
    shotstack: new ShotstackAdapter({ apiKey: 'offline', environment: 'v1', usdToGbpRate: rate }),
    // Pricing only: no client call is made.
    openai: new OpenAIAdapter({
      client: {} as unknown as OpenAIClientLike,
      storage,
      bucket: 'assets',
      usdToGbpRate: rate,
    }),
  };
  return (call: PricedCall) => {
    const adapter = all[call.providerId];
    if (!adapter) throw new Error(`no adapter for ${call.providerId}`);
    return adapter.estimateCostPence(call.request);
  };
}

describe('typical UGC video cost (21.4)', () => {
  it('a 30 s STANDARD video: 3 actor clips of 8 s, each transcribed, no ElevenLabs voice', () => {
    const calls = typicalUgcVideoCalls('STANDARD', 30);
    expect(calls.filter((c) => c.request.capability === 'actor_video')).toHaveLength(3);
    expect(calls.filter((c) => c.request.capability === 'transcription')).toHaveLength(3);
    expect(calls.some((c) => c.request.capability === 'tts')).toBe(false);
    // 21.4a: one actor portrait per video, whatever the number of clips.
    expect(calls.filter((c) => c.request.capability === 'text_to_image')).toHaveLength(1);
    expect(
      typicalUgcVideoCalls('PLUS', 60).filter((c) => c.request.capability === 'text_to_image'),
    ).toHaveLength(1);
    // A fourth 8 s clip would not fit a 30 s short; PLUS buys more on longer videos.
    expect(typicalUgcVideoCalls('PLUS', 30).filter((c) => c.providerId === 'veo')).toHaveLength(3);
    expect(typicalUgcVideoCalls('PLUS', 60).filter((c) => c.providerId === 'veo')).toHaveLength(7);
  });

  it('Veo 3.1 Fast actors: 30 s £1.80 + the rest ≈ £2.30; a 45 s PLUS video £3.00 + the rest', () => {
    const standard = estimateVideoCostPence(typicalUgcVideoCalls('STANDARD', 30), price(0.75));
    expect(standard.byProvider.veo).toBe(180); // 24 s × $0.10 × 0.75
    expect(standard.byProvider.openai).toBe(IMAGE_ESTIMATE_PENCE); // 21.4a: the actor portrait
    expect(standard.totalPence).toBeGreaterThan(190);
    expect(standard.totalPence).toBeLessThanOrEqual(240);
    const plus = estimateVideoCostPence(typicalUgcVideoCalls('PLUS', 45), price(0.75));
    expect(plus.byProvider.veo).toBe(300); // 5 × 8 s = 40 s × $0.10 × 0.75
    expect(plus.totalPence / UGC_BUDGET_PENCE.PLUS).toBeLessThanOrEqual(0.5);
  });

  it('a normal video uses at most ~40% of the default budget, even on the Kling fallback at 0.79', () => {
    for (const tier of ['STANDARD', 'PLUS'] as const) {
      for (const provider of ['veo', 'kling']) {
        const cost = estimateVideoCostPence(
          typicalUgcVideoCalls(tier, 30, provider),
          price(0.79),
        ).totalPence;
        // 21.4a: + the actor portrait (4p) puts the worst case (Kling at 0.79) at ≈ 45.3%.
        expect(cost / ugcProjectBudgetPence(tier)).toBeLessThanOrEqual(0.46);
      }
    }
  });

  it('Veo 3.1 Standard actors ($0.40/s) would cost £7.20 in clips alone on STANDARD: over budget', () => {
    const calls = typicalUgcVideoCalls('STANDARD', 30, 'veo-standard');
    const cost = estimateVideoCostPence(calls, price(0.75));
    expect(cost.byProvider['veo-standard']).toBe(720);
    expect(cost.totalPence).toBeGreaterThan(UGC_BUDGET_PENCE.STANDARD);
  });

  it('default budgets: STANDARD £6, PLUS and ENTERPRISE £7.50', () => {
    expect(ugcProjectBudgetPence('STANDARD')).toBe(600);
    expect(ugcProjectBudgetPence('PLUS')).toBe(750);
    expect(ugcProjectBudgetPence('ENTERPRISE')).toBe(750);
  });
});
