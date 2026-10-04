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
    // 21.3: the Mini fallback (the full model not activated or out of credit).
    'seedance-mini': new SeedanceAdapter({
      apiKey: 'offline',
      usdToGbpRate: rate,
      fullModel: 'dreamina-seedance-2-0-mini-260615',
    }),
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
    expect(typicalVideoPlan('PLUS', 30)).toMatchObject({ aiClips: 6, resolution: '1080p' });
    expect(typicalVideoPlan('ENTERPRISE', 30)).toMatchObject({ aiClips: 6, resolution: '1080p' });
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

describe('21.3 typical 30 s short per tier at list prices (tiered video models)', () => {
  it('the typical short per tier (BASIC Mini 480p, STANDARD 2.0 720p, PLUS 2.0 1080p)', () => {
    expect(TIERS.map((t) => estimate(t, 0.75).totalPence)).toEqual([76, 233, 727]);
    expect(TIERS.map((t) => estimate(t, 0.79).totalPence)).toEqual([79, 241, 763]);
  });

  it("BASIC stays within the catalogue's typical cost (unchanged by 21.3)", () => {
    for (const rate of [0.75, 0.79]) {
      expect(estimate('BASIC', rate).totalPence).toBeLessThanOrEqual(
        TYPICAL_COST_PENCE_PER_VIDEO.BASIC.short,
      );
    }
  });

  it('OPERATOR DECISION PENDING: STANDARD and PLUS now exceed the §P.2 typical cost', () => {
    // The §P.2 figures (and the prices, caps and top-ups sized from them) are unchanged; see
    // PROGRESS 21.3. If they are revised, update this test with them.
    expect(estimate('STANDARD', 0.75).totalPence).toBeGreaterThan(
      TYPICAL_COST_PENCE_PER_VIDEO.STANDARD.short,
    );
    expect(estimate('PLUS', 0.75).totalPence).toBeGreaterThan(
      TYPICAL_COST_PENCE_PER_VIDEO.PLUS.short,
    );
  });

  it('prices the parts as expected at 0.75 (the production rate)', () => {
    // 4 s 9:16 clips: BASIC Mini 480p 40,176 tokens × $3.5/M → 11p; STANDARD 2.0 720p 86,400 ×
    // $7.0/M → 46p; PLUS 2.0 1080p 194,400 × $7.7/M → 113p.
    expect(estimate('BASIC', 0.75).byProvider.seedance).toBe(3 * 11);
    expect(estimate('STANDARD', 0.75).byProvider.seedance).toBe(4 * 46);
    expect(estimate('PLUS', 0.75).byProvider.seedance).toBe(6 * 113);
    // Everything else (script, voice, timing, music, one still, render) ≈ 49p on STANDARD / PLUS.
    expect(estimate('STANDARD', 0.75).totalPence - 4 * 46).toBe(49);
    expect(estimate('PLUS', 0.75).totalPence - 6 * 113).toBe(49);
    // Shotstack: 30 s = 0.5 credit × $0.30 = $0.15 → 12p (was 60p at the spec's 2p a second).
    expect(estimate('STANDARD', 0.75).byProvider.shotstack).toBe(12);
    expect(estimate('BASIC', 0.75).byProvider['elevenlabs-music']).toBeUndefined();
  });

  it('the Mini fallback costs what the tiers cost before 21.3 (PLUS at 720p)', () => {
    expect(estimate('STANDARD', 0.75, 30, 'seedance-mini').totalPence).toBe(141);
    expect(estimate('PLUS', 0.75, 30, 'seedance-mini').totalPence).toBe(187);
  });

  it('long form (the longest each plan allows) stays below the 90% pause of its budget', () => {
    expect(estimate('STANDARD', 0.79, 180).totalPence).toBe(1_411);
    expect(estimate('PLUS', 0.79, 360).totalPence).toBe(6_448);
    for (const tier of ['STANDARD', 'PLUS'] as const) {
      const longSec = PLAN_CATALOGUE[tier].longMaxSec ?? 0;
      for (const rate of [0.75, 0.79]) {
        for (const clip of ['seedance', 'seedance-mini', 'kling', 'veo']) {
          const { totalPence } = estimate(tier, rate, longSec, clip);
          expect(totalPence, `${tier} ${clip}`).toBeLessThan(longFormBudgetPence(tier) * 0.9);
        }
      }
    }
  });

  it('a typical short stays under half of the tier default budget (never near the 90% pause)', () => {
    for (const tier of TIERS) {
      expect(DEFAULT_SHORT_FORM_BUDGET_PENCE).toBeLessThanOrEqual(shortFormBudgetPence(tier));
      expect(estimate(tier, 0.79).totalPence).toBeLessThan(shortFormBudgetPence(tier) / 2);
      // Every failover (Mini, Kling, Veo) stays below the pause too.
      for (const clip of ['seedance-mini', 'kling', 'veo']) {
        expect(estimate(tier, 0.79, 30, clip).totalPence).toBeLessThan(
          shortFormBudgetPence(tier) * 0.9,
        );
      }
    }
  });

  it('a normal video fits the daily cap: a long video and two shorts on STANDARD, a long and three on PLUS', () => {
    const day = (tier: 'STANDARD' | 'PLUS', shorts: number) =>
      estimate(tier, 0.79, PLAN_CATALOGUE[tier].longMaxSec ?? 0).totalPence +
      shorts * estimate(tier, 0.79).totalPence;
    expect(day('STANDARD', 2)).toBeLessThanOrEqual(PLAN_CATALOGUE.STANDARD.dailyCostCapPence);
    expect(day('PLUS', 3)).toBeLessThanOrEqual(PLAN_CATALOGUE.PLUS.dailyCostCapPence);
    // BASIC: its whole daily cap still holds 6 typical shorts.
    expect(6 * estimate('BASIC', 0.79).totalPence).toBeLessThanOrEqual(
      PLAN_CATALOGUE.BASIC.dailyCostCapPence,
    );
  });

  it('monthly caps: BASIC holds its allowance; STANDARD and PLUS do not (operator decision)', () => {
    const shortsInCap = (tier: (typeof TIERS)[number]) =>
      Math.floor(PLAN_CATALOGUE[tier].monthlyCostCapPence / estimate(tier, 0.75).totalPence);
    const plan = PLAN_CATALOGUE.BASIC;
    expect(
      (plan.shortVideosPerMonth ?? 0) * estimate('BASIC', 0.75).totalPence,
    ).toBeLessThanOrEqual(plan.monthlyCostCapPence);
    // Shorts alone (no long video) that fit the unchanged monthly caps: 31 of 40, 36 of 80.
    expect(shortsInCap('STANDARD')).toBe(31);
    expect(shortsInCap('PLUS')).toBe(36);
  });

  it('Kling and Veo now cost less than Seedance 2.0 on STANDARD / PLUS (more on BASIC)', () => {
    for (const clip of ['kling', 'veo']) {
      expect(estimate('BASIC', 0.75, 30, clip).totalPence).toBeGreaterThan(
        estimate('BASIC', 0.75).totalPence,
      );
      for (const tier of ['STANDARD', 'PLUS'] as const) {
        expect(estimate(tier, 0.75, 30, clip).totalPence).toBeLessThan(
          estimate(tier, 0.75).totalPence,
        );
      }
    }
  });
});
