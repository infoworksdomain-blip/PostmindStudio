import type { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import type { ProviderCapability } from '../providers/interface';
import type { ProviderRegistry } from '../providers/registry';
import { activeUgcStyle, scriptLayerMode } from './script-layer';
import { newUgcStyle } from './style';

// BACKLOG 21.4 — Layer 2 for a UGC video vs an ordinary one (shared by plan-project and
// regenerate-script).

function registry(capabilities: ProviderCapability[]): ProviderRegistry {
  return {
    getAdaptersByCapability: (c: ProviderCapability) =>
      capabilities.includes(c) ? [{ providerId: c === 'composition' ? 'shotstack' : 'x' }] : [],
  } as unknown as ProviderRegistry;
}

const all = registry([
  'text_to_video',
  'text_to_image',
  'avatar_video',
  'actor_video',
  'stock_footage',
  'composition',
]);
const ugc = {
  ugc: newUgcStyle({ product: { name: 'Kit', imageId: 'img-1' } }, 5),
} as unknown as Prisma.JsonObject;

describe('scriptLayerMode (21.4)', () => {
  it('an ordinary video keeps the 20.25 treatments and AI clip budget, no supplement', () => {
    const mode = scriptLayerMode({ metadata: {}, tier: 'STANDARD', registry: all });
    expect(mode.ugc).toBeNull();
    expect(mode.treatments).toContain('AI_CLIP');
    expect(mode.treatments).not.toContain('UGC_ACTOR');
    expect(mode.budget(30)).toBe(4);
    expect(mode.supplement(30, 4)).toBeUndefined();
  });

  it('a UGC video: actors and product stills only, actor budget, UGC prompt, 8 s clips with a product', () => {
    const mode = scriptLayerMode({ metadata: ugc, tier: 'STANDARD', registry: all });
    expect(mode.ugc?.style).toBe('UGC_ACTOR');
    // 21.4b: no TEXT_CARD / MOTION_GRAPHICS in a UGC script.
    expect(mode.treatments).toEqual(['UGC_ACTOR', 'IMAGE_STILL']);
    expect(mode.budget(30)).toBe(3);
    expect(mode.supplement(30, 3)).toContain('8 s (at most 16 words)');
    const applied = mode.apply(
      {
        fullText: '',
        shots: [
          {
            sortOrder: 0,
            durationSec: 4,
            visualTreatment: 'UGC_ACTOR',
            sceneDescription: 's',
            cameraDirection: null,
            voiceoverText: 'Okay so this kit is great.',
            onScreenText: null,
            transitionOut: 'cut',
          },
        ],
      },
      { budget: 3, targetSec: 8 },
    );
    expect(applied.plan.shots[0]?.durationSec).toBe(8);
  });

  it('21.4a: without a product photo, the actor portrait still forces 8 s clips when an image generator exists', () => {
    const noProduct = { ugc: newUgcStyle({}, 5) } as unknown as Prisma.JsonObject;
    const mode = scriptLayerMode({ metadata: noProduct, tier: 'STANDARD', registry: all });
    expect(mode.supplement(30, 3)).toContain('each lasts exactly one of: 8 s (at most 16 words).');
    const noImages = scriptLayerMode({
      metadata: noProduct,
      tier: 'STANDARD',
      registry: registry(['actor_video', 'composition']),
    });
    expect(noImages.supplement(30, 3)).toContain('4 s (at most 7 words), 6 s');
  });

  it('no tier gate: a legacy BASIC organisation plans UGC at the STANDARD clip rate', () => {
    expect(activeUgcStyle(ugc)).not.toBeNull();
    const mode = scriptLayerMode({ metadata: ugc, tier: 'BASIC', registry: all });
    expect(mode.ugc).not.toBeNull();
    expect(mode.budget(30)).toBe(3);
  });

  it('with no actor provider the script offers only B-roll (shots fail over to narration later)', () => {
    const mode = scriptLayerMode({
      metadata: ugc,
      tier: 'PLUS',
      registry: registry(['text_to_image', 'composition']),
    });
    expect(mode.treatments).not.toContain('UGC_ACTOR');
  });
});
