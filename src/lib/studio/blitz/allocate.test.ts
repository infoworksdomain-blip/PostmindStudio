import { describe, expect, it } from 'vitest';
import { allocateFormats, keepCheapestFirst, shareSlots } from './allocate';
import { EMPTY_ADJUSTMENTS, type MixPreferences } from './mix';

const mix = (formatWeights: MixPreferences['formatWeights']): MixPreferences => ({
  formatWeights,
  remixPercent: 0,
  mentionBusinessPercent: 30,
  captionStyleWeights: null,
  creatorChance: 0,
  adjustments: EMPTY_ADJUSTMENTS,
});

describe('automation slot formats (lowest cost)', () => {
  it('shares slots by weight with the largest remainder', () => {
    const shares = shareSlots(7, [
      ['carousel', 35],
      ['slideshow', 35],
      ['ai_video', 0],
    ]);
    expect(shares.get('carousel')! + shares.get('slideshow')!).toBe(7);
    // The tie goes to the cheaper format.
    expect(shares.get('carousel')).toBe(4);
    expect(shares.has('ai_video')).toBe(false);
  });

  it('spreads formats through the period instead of blocks', () => {
    const formats = allocateFormats(6, mix({ carousel: 50, slideshow: 50 }), [
      'carousel',
      'slideshow',
    ]);
    expect(formats).toEqual([
      'carousel',
      'slideshow',
      'carousel',
      'slideshow',
      'carousel',
      'slideshow',
    ]);
  });

  it('only uses paid formats when the owner raised their weight', () => {
    expect(
      allocateFormats(10, mix({ carousel: 35, slideshow: 35, ai_video: 0 }), [
        'carousel',
        'slideshow',
        'ai_video',
      ]),
    ).not.toContain('ai_video');
    expect(
      allocateFormats(10, mix({ carousel: 35, slideshow: 35, ai_video: 30 }), [
        'carousel',
        'slideshow',
        'ai_video',
      ]),
    ).toContain('ai_video');
  });

  it('drops the most expensive slots first when the allowance runs short', () => {
    const formats = ['ugc', 'carousel', 'ai_video', 'slideshow', 'carousel'] as const;
    // 3 units: the two carousels and the slideshow; UGC (2 units) and AI video go.
    expect(keepCheapestFirst(formats, 3)).toEqual([1, 3, 4]);
    expect(keepCheapestFirst(formats, null)).toEqual([0, 1, 2, 3, 4]);
    // UGC needs 2 units, so 1 unit left never takes it.
    expect(keepCheapestFirst(['ugc', 'carousel'], 2)).toEqual([1]);
  });

  it('respects a pence ceiling at typical cost, cheapest first', () => {
    const typical = (f: string) => (f === 'ai_video' ? 200 : 20);
    expect(
      keepCheapestFirst(['ai_video', 'carousel', 'slideshow'], null, {
        ceilingPence: 100,
        typicalPence: typical,
      }),
    ).toEqual([1, 2]);
  });
});
