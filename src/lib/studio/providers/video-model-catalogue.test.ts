import { describe, expect, it } from 'vitest';
import { FalAdapter } from './fal';
import type { ProviderAdapter } from './interface';
import { KlingAdapter } from './kling';
import { LumaAdapter } from './luma';
import { createProviderRegistry } from './registry';
import { RunwayAdapter } from './runway';
import { SeedanceAdapter } from './seedance';
import { VeoAdapter } from './veo';
import { ScriptedAdapter } from '../../../../test/helpers/scripted-adapter';
import {
  aiClipTiers,
  buildVideoModelCatalogue,
  nativeRatios,
  relativeCostOf,
} from './video-model-catalogue';

const RATE = 0.75;

function adapters(): ProviderAdapter[] {
  return [
    new SeedanceAdapter({ apiKey: 'k', usdToGbpRate: RATE }),
    new KlingAdapter({ credentials: { kind: 'api_key', apiKey: 'k' }, usdToGbpRate: RATE }),
    new VeoAdapter({ apiKey: 'k', usdToGbpRate: RATE }),
    new RunwayAdapter({ apiKey: 'k', usdToGbpRate: RATE }),
    new LumaAdapter({ apiKey: 'k', usdToGbpRate: RATE }),
  ];
}

const ids = (list: { providerId: string }[]) => list.map((m) => m.providerId);

describe('buildVideoModelCatalogue (25.8)', () => {
  it('lists every registered AI-clip candidate of a paid tier in the router order', () => {
    const models = buildVideoModelCatalogue(createProviderRegistry(adapters()), 'STANDARD');
    expect(ids(models)).toEqual(['seedance', 'kling', 'veo', 'runway', 'luma']);
    expect(models.map((m) => m.displayName)).toEqual([
      'Seedance 2.0',
      'Kling 3.0',
      'Veo 3.1 Fast',
      'Runway Gen-4.5',
      'Luma Ray 3.2',
    ]);
  });

  it('hides Runway and Luma on BASIC (not in its candidate list) and keeps the rest', () => {
    const models = buildVideoModelCatalogue(createProviderRegistry(adapters()), 'BASIC');
    expect(ids(models)).toEqual(['seedance', 'kling', 'veo']);
    expect(models.every((m) => m.tiers.join() === 'BASIC')).toBe(true);
  });

  it('hides providers that are not registered (no key) and adapters without a clip capability', () => {
    const registry = createProviderRegistry([
      new VeoAdapter({ apiKey: 'k', usdToGbpRate: RATE }),
      new ScriptedAdapter('kling', ['tts'], () => ({ state: 'running' })),
    ]);
    expect(ids(buildVideoModelCatalogue(registry, 'ENTERPRISE'))).toEqual(['veo']);
    expect(buildVideoModelCatalogue(createProviderRegistry([]), 'PLUS')).toEqual([]);
  });

  it('describes Luma / Runway by provider id when the adapter is a stand-in', () => {
    const registry = createProviderRegistry([
      new ScriptedAdapter('runway', ['text_to_video'], () => ({ state: 'running' }), 40),
      new ScriptedAdapter('seedance', ['text_to_video'], () => ({ state: 'running' }), 10),
    ]);
    // A seedance stand-in has no model to read, so it is not offered.
    expect(buildVideoModelCatalogue(registry, 'STANDARD')).toEqual([
      expect.objectContaining({
        providerId: 'runway',
        displayName: 'Runway Gen-4.5',
        pencePerClip: 40,
        relativeCost: 1,
        typicalLatencySec: null,
      }),
    ]);
  });

  it('prices a 6 s 9:16 clip from the adapters’ USD constants and the GBP rate', () => {
    const models = buildVideoModelCatalogue(createProviderRegistry(adapters()), 'PLUS');
    const pence = Object.fromEntries(models.map((m) => [m.providerId, m.pencePerClip]));
    // Veo 3.1 Fast $0.10/s × 6 s × 0.75 = 45p; Kling $0.084/s × 6 = 37.8 → 38p; Runway gen4.5
    // 12 credits/s × 6 × $0.01 = $0.72 → 54p; Luma a 10 s clip $0.90 → 67.5 → 68p; Seedance 2.0
    // 720p 9:16: 6 × 720 × 1280 × 24 / 1024 = 129,600 tokens × $7/M = $0.9072 → 68.04 → 69p.
    expect(pence).toEqual({ seedance: 69, kling: 38, veo: 45, runway: 54, luma: 68 });
    expect(Object.fromEntries(models.map((m) => [m.providerId, m.relativeCost]))).toEqual({
      seedance: 2,
      kling: 1,
      veo: 1,
      runway: 2,
      luma: 2,
    });
  });

  it('describes capabilities, clip length, native ratios, latency and silent audio', () => {
    const [seedance, kling, veo, runway, luma] = buildVideoModelCatalogue(
      createProviderRegistry(adapters()),
      'ENTERPRISE',
    );
    expect(seedance).toMatchObject({
      capabilities: ['text_to_video', 'image_to_video'],
      maxClipSec: 30,
      aspectRatios: ['9:16', '16:9', '1:1'],
      audio: false,
      typicalLatencySec: 120,
      tiers: ['BASIC', 'STANDARD', 'PLUS', 'ENTERPRISE'],
    });
    expect(kling).toMatchObject({ maxClipSec: 15, typicalLatencySec: 180 });
    expect(veo).toMatchObject({ maxClipSec: 8, aspectRatios: ['9:16', '16:9'] });
    expect(runway).toMatchObject({
      maxClipSec: 10,
      aspectRatios: ['9:16', '16:9'],
      tiers: ['STANDARD', 'PLUS', 'ENTERPRISE'],
    });
    expect(luma).toMatchObject({ maxClipSec: 10, aspectRatios: ['9:16', '16:9', '1:1'] });
  });

  it('names the configured models (Seedance tier model, Veo model setting)', () => {
    const registry = createProviderRegistry([
      new SeedanceAdapter({
        apiKey: 'k',
        usdToGbpRate: RATE,
        fullModel: 'dreamina-seedance-2-0-mini-260615',
      }),
      new VeoAdapter({ apiKey: 'k', usdToGbpRate: RATE, model: 'veo-3.1-lite-generate-preview' }),
    ]);
    expect(buildVideoModelCatalogue(registry, 'STANDARD').map((m) => m.displayName)).toEqual([
      'Seedance 2.0 Mini',
      'Veo 3.1 Lite',
    ]);
  });

  it('lists the opt-in fal models as one provider with their labels and limits', () => {
    const registry = createProviderRegistry([
      new FalAdapter({ apiKey: 'k', usdToGbpRate: RATE, models: ['ltx-2.3-fast', 'veo-3.1-lite'] }),
    ]);
    const [fal] = buildVideoModelCatalogue(registry, 'BASIC');
    expect(fal).toMatchObject({
      providerId: 'fal',
      displayName: 'fal.ai: LTX-2.3 Fast, Veo 3.1 Lite (fal)',
      maxClipSec: 20,
      aspectRatios: ['9:16', '16:9'],
      // LTX-2.3 Fast first: 6 s at 1080p × $0.06 = $0.36 → 27p.
      pencePerClip: 27,
      relativeCost: 1,
    });
  });
});

describe('catalogue helpers', () => {
  it('aiClipTiers lists the tiers at or below the plan whose list names the provider', () => {
    expect(aiClipTiers('runway', 'PLUS')).toEqual(['STANDARD', 'PLUS']);
    expect(aiClipTiers('seedance', 'BASIC')).toEqual(['BASIC']);
    expect(aiClipTiers('replicate', 'ENTERPRISE')).toEqual(['BASIC']);
    expect(aiClipTiers('heygen', 'ENTERPRISE')).toEqual([]);
  });

  it('nativeRatios keeps only the ratios a provider sends unchanged', () => {
    expect(nativeRatios({ '9:16': '9:16', '16:9': '16:9', '1:1': '16:9', '4:5': '3:4' })).toEqual([
      '9:16',
      '16:9',
    ]);
  });

  it('relativeCostOf buckets against the cheapest price', () => {
    expect(relativeCostOf(10, 10)).toBe(1);
    expect(relativeCostOf(13, 10)).toBe(1);
    expect(relativeCostOf(20, 10)).toBe(2);
    expect(relativeCostOf(21, 10)).toBe(3);
    expect(relativeCostOf(50, 0)).toBe(1);
  });
});
