import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../../../../test/helpers/memory-storage';
import { PLAN_CATALOGUE, TYPICAL_COST_PENCE_PER_VIDEO } from '../billing/catalogue';
import { AnthropicAdapter } from '../providers/anthropic';
import { AssemblyAiAdapter } from '../providers/assemblyai';
import { ElevenLabsAdapter } from '../providers/elevenlabs';
import { ElevenLabsMusicAdapter } from '../providers/elevenlabs-music';
import type { ProviderRequest } from '../providers/interface';
import { KlingAdapter } from '../providers/kling';
import { OpenAIAdapter } from '../providers/openai';
import { SeedanceAdapter } from '../providers/seedance';
import { ShotstackAdapter } from '../providers/shotstack';
import { VeoAdapter } from '../providers/veo';
import {
  DEFAULT_SHORT_FORM_BUDGET_PENCE,
  longFormBudgetPence,
  shortFormBudgetPence,
} from './project-budget';
import {
  estimateVideoCostPence,
  typicalVideoCalls,
  typicalVideoPlan,
  type PricedCall,
} from './video-estimate';

// BACKLOG 20.25 — the cost model: a typical 30 s short per tier, priced with the adapters' own
// list-price estimators, stays at or under the catalogue's typical cost per video.
// The production USD→GBP rate (STUDIO_USD_TO_GBP_RATE) is 0.75: QA run 3 recorded a 4 s Veo 3.1
// Fast clip ($0.40) as 30p. The test also holds at the cost harness's more cautious 0.79.

function adapters(rate: number) {
  const { storage } = memoryStorage();
  const media = { storage, bucket: 'assets', usdToGbpRate: rate };
  const all: Record<string, { estimateCostPence(r: ProviderRequest): number }> = {
    anthropic: new AnthropicAdapter({
      client: new Anthropic({ apiKey: 'offline' }),
      usdToGbpRate: rate,
    }),
    openai: new OpenAIAdapter({ client: new OpenAI({ apiKey: 'offline' }), ...media }),
    seedance: new SeedanceAdapter({ apiKey: 'offline', usdToGbpRate: rate }),
    kling: new KlingAdapter({
      credentials: { kind: 'api_key', apiKey: 'offline' },
      usdToGbpRate: rate,
    }),
    veo: new VeoAdapter({ apiKey: 'offline', usdToGbpRate: rate }),
    elevenlabs: new ElevenLabsAdapter({ apiKey: 'offline', ...media }),
    'elevenlabs-music': new ElevenLabsMusicAdapter({ apiKey: 'offline', ...media }),
    assemblyai: new AssemblyAiAdapter({ apiKey: 'offline', usdToGbpRate: rate }),
    shotstack: new ShotstackAdapter({ apiKey: 'offline', environment: 'v1', usdToGbpRate: rate }),
  };
  return (call: PricedCall) => {
    const adapter = all[call.providerId];
    if (!adapter) throw new Error(`no adapter for ${call.providerId}`);
    return adapter.estimateCostPence(call.request);
  };
}

const TIERS = ['BASIC', 'STANDARD', 'PLUS'] as const;

function estimate(tier: (typeof TIERS)[number], rate: number, durationSec = 30, clip = 'seedance') {
  return estimateVideoCostPence(
    typicalVideoCalls(typicalVideoPlan(tier, durationSec), clip),
    adapters(rate),
  );
}

describe('typicalVideoPlan', () => {
  it('a 30 s short: 10 shots, AI clips by tier, 480p on BASIC, music from STANDARD', () => {
    expect(typicalVideoPlan('BASIC', 30)).toMatchObject({
      shots: 10,
      aiClips: 3,
      aiClipSec: 4,
      resolution: '480p',
      generatedStills: 1,
      music: false,
    });
    expect(typicalVideoPlan('STANDARD', 30)).toMatchObject({
      aiClips: 4,
      resolution: '720p',
      music: true,
    });
    expect(typicalVideoPlan('PLUS', 30)).toMatchObject({ aiClips: 6, resolution: '720p' });
  });

  it('never plans more AI clips than shots', () => {
    expect(typicalVideoPlan('PLUS', 4).aiClips).toBe(2);
    expect(typicalVideoPlan('PLUS', 3)).toMatchObject({ shots: 1, aiClips: 1, generatedStills: 0 });
  });
});

describe('estimateVideoCostPence', () => {
  it('sums the priced calls in total and per provider', () => {
    const calls: PricedCall[] = [
      {
        providerId: 'a',
        request: { capability: 'tts', organisationId: 'o', text: 'x', voiceId: 'v' },
      },
      {
        providerId: 'a',
        request: { capability: 'tts', organisationId: 'o', text: 'x', voiceId: 'v' },
      },
      {
        providerId: 'b',
        request: { capability: 'tts', organisationId: 'o', text: 'x', voiceId: 'v' },
      },
    ];
    expect(estimateVideoCostPence(calls, (c) => (c.providerId === 'a' ? 2 : 5))).toEqual({
      totalPence: 9,
      byProvider: { a: 4, b: 5 },
    });
  });
});

describe('20.25 typical 30 s short per tier at list prices', () => {
  for (const rate of [0.75, 0.79]) {
    for (const tier of TIERS) {
      it(`${tier} at USD→GBP ${rate} is within the catalogue's typical cost`, () => {
        const { totalPence } = estimate(tier, rate);
        expect(totalPence).toBeLessThanOrEqual(TYPICAL_COST_PENCE_PER_VIDEO[tier].short);
      });
    }
  }

  it('prices the parts as expected at 0.75 (the production rate)', () => {
    // Seedance 2.0 mini, 4 s, 9:16: 720p 86,400 tokens = $0.302 → 23p; 480p 40,176 = $0.141 → 11p.
    expect(estimate('BASIC', 0.75).byProvider.seedance).toBe(3 * 11);
    expect(estimate('STANDARD', 0.75).byProvider.seedance).toBe(4 * 23);
    expect(estimate('PLUS', 0.75).byProvider.seedance).toBe(6 * 23);
    // Shotstack: 30 s = 0.5 credit × $0.30 = $0.15 → 12p (was 60p at the spec's 2p a second).
    expect(estimate('STANDARD', 0.75).byProvider.shotstack).toBe(12);
    expect(estimate('BASIC', 0.75).byProvider['elevenlabs-music']).toBeUndefined();
  });

  it('long form (the longest each plan allows) stays within the typical long-video cost', () => {
    for (const tier of ['STANDARD', 'PLUS'] as const) {
      const longSec = PLAN_CATALOGUE[tier].longMaxSec ?? 0;
      for (const rate of [0.75, 0.79]) {
        const { totalPence } = estimate(tier, rate, longSec);
        expect(totalPence).toBeLessThanOrEqual(TYPICAL_COST_PENCE_PER_VIDEO[tier].long);
        expect(totalPence).toBeLessThan(longFormBudgetPence(tier) * 0.9);
      }
    }
  });

  it('a typical short stays under half of the tier default budget (never near the 90% pause)', () => {
    for (const tier of TIERS) {
      expect(DEFAULT_SHORT_FORM_BUDGET_PENCE).toBeLessThanOrEqual(shortFormBudgetPence(tier));
      expect(estimate(tier, 0.79).totalPence).toBeLessThan(shortFormBudgetPence(tier) / 2);
      // Even on the dearest failover (Veo), a short stays below the pause.
      expect(estimate(tier, 0.79, 30, 'veo').totalPence).toBeLessThan(
        shortFormBudgetPence(tier) * 0.9,
      );
    }
  });

  it('the plan caps hold the whole allowance at the typical cost', () => {
    for (const tier of TIERS) {
      const plan = PLAN_CATALOGUE[tier];
      const month = (plan.shortVideosPerMonth ?? 0) * estimate(tier, 0.75).totalPence;
      expect(month).toBeLessThanOrEqual(plan.monthlyCostCapPence);
    }
  });

  it('a Kling or Veo failover costs more than Seedance (reported, not budgeted)', () => {
    const seedance = estimate('STANDARD', 0.75).totalPence;
    expect(estimate('STANDARD', 0.75, 30, 'kling').totalPence).toBeGreaterThan(seedance);
    expect(estimate('STANDARD', 0.75, 30, 'veo').totalPence).toBeGreaterThan(seedance);
  });
});
