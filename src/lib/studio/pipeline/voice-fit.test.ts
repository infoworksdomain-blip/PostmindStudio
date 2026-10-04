import { describe, expect, it } from 'vitest';
import {
  decideFit,
  fitOf,
  narrationSec,
  parseStockVoices,
  selectStockVoice,
  trimAtWordBoundary,
  voiceTrimSecOf,
} from './voice-fit';

// 15.B3 — narration fit decision (spec 5.5 ±5%) and tone-matched stock voices.

const words = [
  { text: 'Fresh', startSec: 0.1, endSec: 0.5 },
  { text: 'bread', startSec: 0.6, endSec: 1.1 },
  { text: 'every', startSec: 1.2, endSec: 1.9 },
  { text: 'morning', startSec: 2.0, endSec: 2.9 },
];
const base = {
  words,
  extendBudgetSec: 2,
  canSpeedUp: true,
  alreadySped: false,
};

describe('decideFit', () => {
  it('accepts narration that ends inside the shot, with 0.05 s of rounding', () => {
    expect(decideFit({ ...base, voiceSec: 2.6, shotSec: 2.8, treatment: 'AI_CLIP' }).strategy).toBe(
      'fits',
    );
    expect(
      decideFit({ ...base, voiceSec: 2.84, shotSec: 2.8, treatment: 'AI_CLIP' }).strategy,
    ).toBe('fits');
  });

  it('does not let narration overrun its shot inside the ±5% pace band (2026-10-04)', () => {
    // Production: 3.09 s of narration in a 3.00 s still was called "fits", the composer cut the
    // voice clip at 3.00 s and audio_sync failed the render. A still is held longer instead.
    expect(
      decideFit({ ...base, voiceSec: 3.09, shotSec: 3, treatment: 'IMAGE_STILL' }),
    ).toMatchObject({ strategy: 'extend', newShotSec: 3.3 });
    // A video shot cannot be held, so the line is regenerated slightly faster.
    expect(decideFit({ ...base, voiceSec: 2.9, shotSec: 2.8, treatment: 'AI_CLIP' })).toMatchObject(
      {
        strategy: 'speed',
        speed: 1.06,
      },
    );
  });

  it('extends a still/text/motion shot when the script can absorb it', () => {
    const d = decideFit({ ...base, voiceSec: 2.9, shotSec: 2, treatment: 'IMAGE_STILL' });
    expect(d).toMatchObject({ strategy: 'extend', newShotSec: 3.1 });
    const tight = decideFit({
      ...base,
      extendBudgetSec: 0.5,
      voiceSec: 2.9,
      shotSec: 2,
      treatment: 'MOTION_GRAPHICS',
    });
    expect(tight.strategy).toBe('trim'); // 1.45x is beyond the 1.2 speed limit
  });

  it('speeds up a video shot within ElevenLabs’ documented 1.2 maximum, once', () => {
    const d = decideFit({ ...base, voiceSec: 2.9, shotSec: 2.6, treatment: 'AI_CLIP' });
    expect(d).toMatchObject({ strategy: 'speed', speed: 1.14 });
    const again = decideFit({
      ...base,
      alreadySped: true,
      voiceSec: 2.9,
      shotSec: 2.6,
      treatment: 'AI_CLIP',
    });
    expect(again).toMatchObject({ strategy: 'trim', trimSec: 1.95, wordBoundary: true });
  });

  it('trims at the last whole word when too long to speed up', () => {
    const d = decideFit({ ...base, voiceSec: 2.9, shotSec: 1.5, treatment: 'AI_CLIP' });
    expect(d).toMatchObject({ strategy: 'trim', trimSec: 1.15, wordBoundary: true });
    const noTiming = decideFit({
      ...base,
      words: [],
      canSpeedUp: false,
      voiceSec: 5,
      shotSec: 3,
      treatment: 'AI_AVATAR',
    });
    expect(noTiming).toMatchObject({ strategy: 'trim', trimSec: 3, wordBoundary: false });
  });

  it('reports unmeasured narration instead of guessing', () => {
    expect(decideFit({ ...base, voiceSec: null, shotSec: 3, treatment: 'AI_CLIP' }).strategy).toBe(
      'unmeasured',
    );
  });
});

describe('measurement helpers', () => {
  it('prefers the last spoken word over the probed length', () => {
    expect(narrationSec(words, 4.2)).toBe(2.9);
    expect(narrationSec([], 4.2)).toBe(4.2);
    expect(narrationSec([], null)).toBeNull();
    expect(trimAtWordBoundary(words, 0.3)).toBeNull();
  });

  it('reads the stored fit back from asset metadata', () => {
    const metadata = { fit: { strategy: 'trim', trimSec: 1.15, voiceSec: 2.9, shotSec: 1.5 } };
    expect(voiceTrimSecOf(metadata)).toBe(1.15);
    expect(fitOf(metadata)?.strategy).toBe('trim');
    expect(voiceTrimSecOf({ fit: { strategy: 'fits' } })).toBeNull();
    expect(voiceTrimSecOf(null)).toBeNull();
  });
});

describe('stock voices (STUDIO_STOCK_VOICES)', () => {
  const voices = parseStockVoices(
    'warm=v_warm, energetic=v_energy,professional=v_pro,playful=v_play,calm=v_calm,warm@fr=v_warm_fr,bad=has space,=x',
  );

  it('parses tone=voice pairs and per-language overrides, ignoring junk', () => {
    expect(voices.get('warm')).toBe('v_warm');
    expect(voices.get('warm@fr')).toBe('v_warm_fr');
    expect(voices.has('bad')).toBe(false);
    expect(voices.size).toBe(6);
  });

  it('matches the first tone keyword, preferring the script language', () => {
    expect(selectStockVoice(['Confident', 'warm and friendly'], 'en-GB', voices)).toBe('v_warm');
    expect(selectStockVoice(['warm'], 'fr', voices)).toBe('v_warm_fr');
    expect(selectStockVoice(['Energetic'], 'de', voices)).toBe('v_energy');
    expect(selectStockVoice(['quirky'], 'en-GB', voices)).toBeNull();
    expect(selectStockVoice(['warm'], 'en-GB', new Map())).toBeNull();
  });
});
