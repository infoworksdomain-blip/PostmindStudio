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
  it('a 30 s short: 10 shots, AI clips by tier, 720p HD on every tier (21.3), music from STANDARD', () => {
    expect(typicalVideoPlan('BASIC', 30)).toMatchObject({
      shots: 10,
      aiClips: 3,
      aiClipSec: 4,
      resolution: '720p',
      generatedStills: 1,
      music: false,
    });
    expect(typicalVideoPlan('STANDARD', 30)).toMatchObject({
      aiClips: 4,
      resolution: '720p',
      music: true,
    });
    expect(typicalVideoPlan('PLUS', 30)).toMatchObject({ aiClips: 6, resolution: '720p' });
    expect(typicalVideoPlan('ENTERPRISE', 30)).toMatchObject({ aiClips: 6, resolution: '720p' });
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

describe('21.3 typical 30 s short at list prices (full Seedance 2.0 at 720p HD on every tier)', () => {
  it('STANDARD (the per-channel subscription) costs about £2.23 (£2.32 at 0.79)', () => {
    // 23.2: 10p less than before (181 / 233 / 325): narration is no longer transcribed.
    expect(TIERS.map((t) => estimate(t, 0.75).totalPence)).toEqual([171, 223, 315]);
    expect(TIERS.map((t) => estimate(t, 0.79).totalPence)).toEqual([178, 232, 328]);
  });

  it('prices the parts as expected at 0.75 (the production rate)', () => {
    // A 4 s 9:16 720p clip on the full 2.0: 86,400 tokens × $7.0/M = $0.6048 → 46p.
    expect(estimate('BASIC', 0.75).byProvider.seedance).toBe(3 * 46);
    expect(estimate('STANDARD', 0.75).byProvider.seedance).toBe(4 * 46);
    expect(estimate('PLUS', 0.75).byProvider.seedance).toBe(6 * 46);
    // Everything else (script, voice, music, one still, render) is 39p on STANDARD (23.2: 49p with
    // the narration transcription that the TTS alignment replaced).
    expect(estimate('STANDARD', 0.75).totalPence - 4 * 46).toBe(39);
    // Shotstack: 30 s = 0.5 credit × $0.30 = $0.15 → 12p (was 60p at the spec's 2p a second).
    expect(estimate('STANDARD', 0.75).byProvider.shotstack).toBe(12);
    expect(estimate('BASIC', 0.75).byProvider['elevenlabs-music']).toBeUndefined();
  });

  it('OPERATOR NOTE: the full model costs more than the §P.2 typical cost per short', () => {
    // §P.2 (prices, caps, top-ups) is unchanged here; the billing rework (per-channel plan)
    // owns it. If those figures change, update this test with them.
    // 21.5 (billing rework): STANDARD, the tier every channel subscription uses, now carries the
    // full-model figure (241p), so its typical cost covers the estimate; the legacy tiers do not.
    for (const tier of TIERS) {
      if (tier === 'STANDARD')
        expect(estimate(tier, 0.75).totalPence).toBeLessThanOrEqual(
          TYPICAL_COST_PENCE_PER_VIDEO[tier].short,
        );
      else
        expect(estimate(tier, 0.75).totalPence).toBeGreaterThan(
          TYPICAL_COST_PENCE_PER_VIDEO[tier].short,
        );
    }
  });

  it('the Mini fallback costs what the tiers cost before 21.3 at 720p, less 23.2 timing', () => {
    expect(estimate('STANDARD', 0.75, 30, 'seedance-mini').totalPence).toBe(131);
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

  it('long form (the longest each plan allows) stays below the 90% pause of its budget', () => {
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

  it('daily caps (unchanged) still hold several normal shorts a day', () => {
    // STANDARD £15: 6 shorts; BASIC £5: 2 shorts; PLUS £45: 13 shorts (at 0.79).
    expect(
      Math.floor(PLAN_CATALOGUE.STANDARD.dailyCostCapPence / estimate('STANDARD', 0.79).totalPence),
    ).toBe(6);
    expect(
      Math.floor(PLAN_CATALOGUE.BASIC.dailyCostCapPence / estimate('BASIC', 0.79).totalPence),
    ).toBe(2);
    expect(
      Math.floor(PLAN_CATALOGUE.PLUS.dailyCostCapPence / estimate('PLUS', 0.79).totalPence),
    ).toBe(13);
  });

  it('Kling (720p) now costs less than Seedance 2.0; Veo 3.1 Fast too', () => {
    for (const clip of ['kling', 'veo']) {
      expect(estimate('STANDARD', 0.75, 30, clip).totalPence).toBeLessThan(
        estimate('STANDARD', 0.75).totalPence,
      );
    }
  });
});
