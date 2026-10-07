import { describe, expect, it } from 'vitest';
import {
  FAL_VIDEO_MODEL_KEYS,
  FAL_VIDEO_MODELS,
  falEndpointFor,
  isFalVideoModelKey,
} from './fal-models';
import type { TextToVideoRequest } from './interface';
import { FAL_VIDEO_USD_PER_SECOND } from './pricing';

const t2v: TextToVideoRequest = {
  capability: 'text_to_video',
  organisationId: 'org-1',
  prompt: 'A loaf on a counter',
  durationSec: 5,
  aspectRatio: '16:9',
};

describe('fal video models (24.1)', () => {
  it('lists the documented endpoint ids', () => {
    expect(FAL_VIDEO_MODEL_KEYS.map((k) => FAL_VIDEO_MODELS[k].endpoints)).toEqual([
      { t2v: 'minimax/h3-max/text-to-video', i2v: 'minimax/h3-max/image-to-video' },
      { t2v: 'fal-ai/ltx-2.3/text-to-video/fast', i2v: 'fal-ai/ltx-2.3/image-to-video/fast' },
      { t2v: 'fal-ai/veo3.1/lite', i2v: 'fal-ai/veo3.1/lite/image-to-video' },
    ]);
    expect(falEndpointFor('veo-3.1-lite', 'i2v')).toBe('fal-ai/veo3.1/lite/image-to-video');
    expect(isFalVideoModelKey('ltx-2.3-fast')).toBe(true);
    expect(isFalVideoModelKey('constructor')).toBe(false);
  });

  it('prices every model from pricing.ts', () => {
    expect(FAL_VIDEO_USD_PER_SECOND['minimax-h3-max']['768P']).toBe(0.08);
    expect(FAL_VIDEO_USD_PER_SECOND['ltx-2.3-fast']['1080p']).toBe(0.06);
    expect(FAL_VIDEO_USD_PER_SECOND['veo-3.1-lite']['720p']).toBe(0.03);
  });

  it('MiniMax H3 Max: 0.92–15 s, any Studio ratio, 50 000-character prompts', () => {
    const h3 = FAL_VIDEO_MODELS['minimax-h3-max'];
    expect(h3.plan({ ...t2v, durationSec: 0.5 })).toBeUndefined();
    expect(h3.plan({ ...t2v, durationSec: 16 })).toBeUndefined();
    expect(h3.plan({ ...t2v, prompt: '   ' })).toBeUndefined();
    expect(h3.plan({ ...t2v, prompt: 'x'.repeat(50_001) })).toBeUndefined();
    expect(h3.plan({ ...t2v, aspectRatio: '1:1', durationSec: 15 })).toMatchObject({
      billedSec: 15,
      input: { aspect_ratio: '1:1', resolution: '768P' },
    });
    expect(h3.plan({ ...t2v, resolution: '480p' })).toMatchObject({
      usdPerSec: 0.05,
      resolution: '480P',
    });
  });

  it('LTX-2.3 Fast: 6–20 s in even steps, 16:9 / 9:16 only, 5000-character prompts', () => {
    const ltx = FAL_VIDEO_MODELS['ltx-2.3-fast'];
    expect(ltx.plan({ ...t2v, durationSec: 2 })?.billedSec).toBe(6);
    expect(ltx.plan({ ...t2v, durationSec: 19.5 })?.billedSec).toBe(20);
    expect(ltx.plan({ ...t2v, durationSec: 21 })).toBeUndefined();
    expect(ltx.plan({ ...t2v, durationSec: 0 })).toBeUndefined();
    expect(ltx.plan({ ...t2v, aspectRatio: '1:1' })).toBeUndefined();
    expect(ltx.plan({ ...t2v, prompt: 'x'.repeat(5001) })).toBeUndefined();
  });

  it('Veo 3.1 Lite: 4 / 6 / 8 s, 720p unless 1080p is asked for', () => {
    const veo = FAL_VIDEO_MODELS['veo-3.1-lite'];
    expect(veo.plan({ ...t2v, durationSec: 3 })?.input).toMatchObject({ duration: '4s' });
    expect(veo.plan({ ...t2v, durationSec: 8.5 })).toBeUndefined();
    expect(veo.plan({ ...t2v, resolution: '1080p' })).toMatchObject({
      usdPerSec: 0.05,
      resolution: '1080p',
    });
    expect(veo.plan({ ...t2v, aspectRatio: '1:1' })).toBeUndefined();
  });
});
