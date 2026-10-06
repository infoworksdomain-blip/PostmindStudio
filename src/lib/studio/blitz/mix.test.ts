import { describe, expect, it } from 'vitest';
import {
  applySignal,
  describeAdjustments,
  effectiveAngleWeight,
  effectiveFormatWeight,
  effectiveMentionPercent,
  EMPTY_ADJUSTMENTS,
  MAX_NUDGE,
  pickFormat,
  pickWeighted,
  readFormatWeights,
  type MixPreferences,
} from './mix';

const mix = (over: Partial<MixPreferences> = {}): MixPreferences => ({
  formatWeights: { carousel: 35, slideshow: 35, ai_video: 0, ugc: 0 },
  remixPercent: 20,
  mentionBusinessPercent: 30,
  captionStyleWeights: null,
  creatorChance: 0,
  adjustments: EMPTY_ADJUSTMENTS,
  ...over,
});

describe('weighted picks', () => {
  it('picks by weight and never a zero weight', () => {
    const entries = [
      ['a', 1],
      ['b', 0],
      ['c', 3],
    ] as const;
    expect(pickWeighted(entries, 0)).toBe('a');
    expect(pickWeighted(entries, 0.3)).toBe('c');
    expect(pickWeighted(entries, 0.999)).toBe('c');
    expect(pickWeighted([['x', 0]] as const, 0.5)).toBeNull();
  });

  it('never picks a paid format left at 0', () => {
    const prefs = mix();
    for (let r = 0; r < 1; r += 0.05)
      expect(['carousel', 'slideshow']).toContain(
        pickFormat(prefs, ['carousel', 'slideshow', 'ai_video', 'ugc'], r),
      );
  });
});

describe('skip reasons and keeps (bounded, explainable)', () => {
  it('"Not my style" makes the format rarer and says so', () => {
    const { adjustments, notice } = applySignal(mix(), {
      action: 'skip',
      reason: 'not_my_style',
      format: 'carousel',
    });
    expect(adjustments.formats.carousel).toBe(-5);
    expect(notice).toEqual({ kind: 'fewer_format', format: 'carousel' });
    expect(effectiveFormatWeight({ ...mix(), adjustments }, 'carousel')).toBe(30);
  });

  it('caps every nudge at ±MAX_NUDGE and then reports the limit', () => {
    let prefs = mix();
    let last = null;
    for (let i = 0; i < 10; i += 1) {
      const r = applySignal(prefs, { action: 'skip', reason: 'not_my_style', format: 'slideshow' });
      prefs = { ...prefs, adjustments: r.adjustments };
      last = r.notice;
    }
    expect(prefs.adjustments.formats.slideshow).toBe(-MAX_NUDGE);
    expect(last).toEqual({ kind: 'at_limit' });
    expect(effectiveFormatWeight(prefs, 'slideshow')).toBe(35 - MAX_NUDGE);
  });

  it('never nudges a format the owner set to 0 (paid formats stay off)', () => {
    const r = applySignal(mix(), { action: 'more_like_this', format: 'ugc' });
    expect(r.adjustments.formats.ugc).toBeUndefined();
    expect(effectiveFormatWeight({ ...mix(), adjustments: r.adjustments }, 'ugc')).toBe(0);
  });

  it('"Wrong topic" and "Seen it" make the angle rarer; "Too salesy" names the business less', () => {
    const angle = { id: 'ang1', title: 'Weekend bakes' };
    const wrong = applySignal(mix(), {
      action: 'skip',
      reason: 'wrong_topic',
      format: 'carousel',
      angle,
    });
    expect(wrong.adjustments.angles.ang1).toBe(-10);
    expect(wrong.notice).toEqual({ kind: 'fewer_angle', angleTitle: 'Weekend bakes' });
    expect(effectiveAngleWeight(wrong.adjustments, { id: 'ang1', weight: 50 })).toBe(40);
    const seen = applySignal(mix(), {
      action: 'skip',
      reason: 'seen_it',
      format: 'carousel',
      angle,
    });
    expect(seen.adjustments.angles.ang1).toBe(-5);
    const salesy = applySignal(mix(), { action: 'skip', reason: 'too_salesy', format: 'carousel' });
    expect(salesy.notice).toEqual({ kind: 'less_salesy' });
    expect(effectiveMentionPercent({ ...mix(), adjustments: salesy.adjustments })).toBe(20);
  });

  it('a keep moves the format and angle back up a little; a plain skip says nothing', () => {
    const keep = applySignal(mix(), {
      action: 'keep',
      format: 'carousel',
      angle: { id: 'a', title: 'A' },
    });
    expect(keep.adjustments.formats.carousel).toBe(2);
    expect(keep.adjustments.angles.a).toBe(3);
    expect(keep.notice).toBeNull();
    expect(applySignal(mix(), { action: 'skip', format: 'carousel' }).notice).toBeNull();
  });

  it('describes the nudges in force and reads stored weights safely', () => {
    expect(
      describeAdjustments({
        formats: { carousel: -5, slideshow: 0 },
        angles: { a: 3 },
        mention: -10,
      }),
    ).toEqual([
      { target: 'format', id: 'carousel', delta: -5 },
      { target: 'angle', id: 'a', delta: 3 },
      { target: 'mention', id: 'mention', delta: -10 },
    ]);
    expect(readFormatWeights({ carousel: 140, nope: 5, slideshow: 'x', ugc: 12.6 })).toEqual({
      carousel: 100,
      ugc: 13,
    });
  });
});
