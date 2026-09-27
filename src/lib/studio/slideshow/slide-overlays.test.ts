import { describe, expect, it } from 'vitest';
import {
  defaultSlideOverlays,
  presetKeyForRecipe,
  recipesByRole,
  slideCaption,
} from './slide-overlays';

const slide = (id: string, slideType: string, metadata: Record<string, unknown>) =>
  ({ id, slideType, durationSec: 2.5, metadata }) as Parameters<
    typeof defaultSlideOverlays
  >[0][number];

describe('presetKeyForRecipe', () => {
  it('maps template recipes to built-in presets and accepts preset keys as is', () => {
    expect(presetKeyForRecipe('listicle_number')).toBe('subtitle_box');
    expect(presetKeyForRecipe('name_and_role')).toBe('quote_author_byline');
    expect(presetKeyForRecipe('quote_serif')).toBe('quote_serif');
    expect(presetKeyForRecipe('made_up')).toBeNull();
  });
});

describe('recipesByRole', () => {
  it('reads { role: { preset } } and ignores anything else', () => {
    expect(recipesByRole({ body: { preset: 'listicle_number' }, cta: 'x', hook: {} })).toEqual({
      body: 'listicle_number',
    });
    expect(recipesByRole(null)).toEqual({});
    expect(recipesByRole([1])).toEqual({});
  });
});

describe('slideCaption', () => {
  it('matches the caption the slideshow EDL draws', () => {
    expect(slideCaption({ number: 2, text: 'Baked at dawn' })).toBe('2. Baked at dawn');
    expect(slideCaption({ caption: 'Own caption', text: 'ignored' })).toBe('Own caption');
    expect(slideCaption({})).toBeNull();
  });
});

describe('defaultSlideOverlays', () => {
  it('gives captioned image slides of a role with a recipe one styled overlay', () => {
    const out = defaultSlideOverlays(
      [
        slide('a', 'TEXT_CARD', { role: 'hook', text: 'Hook' }),
        slide('b', 'IMAGE_STILL', { role: 'body', number: 1, text: 'Slow ferment' }),
        slide('c', 'IMAGE_STILL', { role: 'body', number: 2, text: 'Has one already' }),
        slide('d', 'IMAGE_KENBURNS', { role: 'body' }),
        slide('e', 'QUOTE', { role: 'body', quote: 'Q' }),
      ],
      { body: 'listicle_number', hook: 'listicle_number' },
      new Set(['c']),
    );
    expect(out).toEqual([
      { slideId: 'b', text: '1. Slow ferment', presetKey: 'subtitle_box', durationSec: 2.5 },
    ]);
  });
});
