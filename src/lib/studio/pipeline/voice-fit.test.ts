import { describe, expect, it } from 'vitest';
import {
  decideFit,
  endsSentence,
  fitOf,
  fittedShotSec,
  narrationSec,
  parseStockVoices,
  selectStockVoice,
  trimAtSentenceBoundary,
  trimAtWordBoundary,
  trimDecision,
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

  it('trims at the end of a sentence rather than mid-sentence when one ends inside the shot (21.1)', () => {
    const twoSentences = [
      { text: 'Fresh', startSec: 0.1, endSec: 0.5 },
      { text: 'bread.', startSec: 0.6, endSec: 1.1 },
      { text: 'Every', startSec: 1.2, endSec: 1.6 },
      { text: 'single', startSec: 1.7, endSec: 2.1 },
      { text: 'morning!', startSec: 2.2, endSec: 2.9 },
    ];
    const d = decideFit({
      ...base,
      words: twoSentences,
      canSpeedUp: false,
      voiceSec: 2.9,
      shotSec: 2.3,
      treatment: 'AI_CLIP',
    });
    expect(d).toMatchObject({
      strategy: 'trim',
      trimSec: 1.15,
      wordBoundary: true,
      sentenceBoundary: true,
      droppedWords: 3,
    });
  });

  it('falls back to the last whole word when no sentence ends inside the shot (QA run 8)', () => {
    // The 2.5 s still of production QA run 8: one sentence, 2.741 s after the speed-up.
    const run8 = [
      { text: 'Walk', startSec: 0.097, endSec: 0.358 },
      { text: 'into', startSec: 0.358, endSec: 0.489 },
      { text: 'every', startSec: 0.603, endSec: 0.815 },
      { text: 'call', startSec: 0.93, endSec: 1.142 },
      { text: 'like', startSec: 1.256, endSec: 1.435 },
      { text: "you've", startSec: 1.484, endSec: 1.631 },
      { text: 'had', startSec: 1.648, endSec: 1.794 },
      { text: 'hours', startSec: 1.974, endSec: 2.121 },
      { text: 'to', startSec: 2.235, endSec: 2.365 },
      { text: 'prep.', startSec: 2.382, endSec: 2.741 },
    ];
    expect(trimDecision(run8, 2.741, 2.5)).toMatchObject({
      trimSec: 2.415,
      wordBoundary: true,
      sentenceBoundary: false,
      droppedWords: 1,
    });
    expect(trimAtSentenceBoundary(run8, 2.5)).toBeNull();
    expect(trimDecision([], 5, 3)).toMatchObject({
      trimSec: 3,
      wordBoundary: false,
      sentenceBoundary: false,
      droppedWords: 0,
    });
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

  it('sizes a shot to its narration plus the tail, rounded up to 0.1 s', () => {
    expect(fittedShotSec(2.741)).toBe(3);
    expect(fittedShotSec(3.09)).toBe(3.3);
    expect(fittedShotSec(2.9)).toBe(3.1);
    expect(fittedShotSec(2.8)).toBe(3);
  });

  it('recognises sentence ends across scripts, with closing quotes', () => {
    for (const w of ['prep.', 'now!', 'why?', 'so…', 'done."', 'ok.”', '好。', 'لماذا؟', 'है।'])
      expect(endsSentence(w)).toBe(true);
    for (const w of ['prep', 'well,', 'to', '"quoted', '3,5']) expect(endsSentence(w)).toBe(false);
  });

  it('reads the stored fit back from asset metadata', () => {
    const metadata = { fit: { strategy: 'trim', trimSec: 1.15, voiceSec: 2.9, shotSec: 1.5 } };
    expect(voiceTrimSecOf(metadata)).toBe(1.15);
    expect(fitOf(metadata)?.strategy).toBe('trim');
    expect(voiceTrimSecOf({ fit: { strategy: 'fits' } })).toBeNull();
    // 21.1: a rebalanced shot plays its narration whole (composer and captions see no trim).
    expect(voiceTrimSecOf({ fit: { strategy: 'rebalance', newShotSec: 3 } })).toBeNull();
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
