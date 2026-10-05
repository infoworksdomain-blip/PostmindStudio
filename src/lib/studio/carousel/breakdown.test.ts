import { describe, expect, it } from 'vitest';
import {
  fitFontSize,
  isLongPost,
  isShortPost,
  planSlides,
  splitImageLabel,
  splitTextToFit,
} from './breakdown';
import { BODY_FONT_SIZES, MIN_BODY_FONT_SIZE } from './constants';
import type { MeasureText } from './text';
import type { CarouselImage, CarouselPost } from './types';

/** A fixed-advance font: every character is 0.5 em (900 px holds ~39 characters at 46 px). */
const measure: MeasureText = (text, fontSize) => [...text].length * fontSize * 0.5;

const LANDSCAPE: CarouselImage = { imageId: 'img', width: 1600, height: 900, aiGenerated: false };
const post = (id: string, text: string, image: CarouselImage | null = null): CarouselPost => ({
  id,
  text,
  image,
});
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

describe('planSlides', () => {
  it('gives the hook and the call to action their own slides and pairs short posts between', () => {
    const plans = planSlides(
      [
        post('hook', 'A short hook'),
        post('a', 'Short one'),
        post('b', 'Short two'),
        post('c', 'Short three'),
        post('cta', 'Follow for more'),
      ],
      measure,
    );
    expect(plans.map((p) => p.parts.map((x) => x.postId))).toEqual([
      ['hook'],
      ['a', 'b'],
      ['c'],
      ['cta'],
    ]);
    expect(plans.map((p) => p.kind)).toEqual(['single', 'pair', 'single', 'single']);
    expect(plans.map((p) => p.index)).toEqual([0, 1, 2, 3]);
  });

  it('never pairs a post with a picture or a long post', () => {
    const plans = planSlides(
      [
        post('hook', 'Hook', LANDSCAPE),
        post('a', 'Short with picture', LANDSCAPE),
        post('b', 'Short'),
        post('c', 'x'.repeat(170)),
        post('d', 'Short again'),
        post('cta', 'Save this'),
      ],
      measure,
    );
    expect(plans.map((p) => p.parts.map((x) => x.postId))).toEqual([
      ['hook'],
      ['a'],
      ['b'],
      ['c'],
      ['d'],
      ['cta'],
    ]);
  });

  it('splits an image post with long text into a short label and a text-only detail slide', () => {
    const text = `First sentence is the label. ${words(40)}.`;
    const plans = planSlides(
      [post('hook', 'Hook'), post('p', text, LANDSCAPE), post('cta', 'Follow')],
      measure,
    );
    const parts = plans.filter((p) => p.parts.some((x) => x.postId === 'p'));
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts[0]?.parts[0]).toMatchObject({
      text: 'First sentence is the label.',
      partIndex: 0,
    });
    expect(parts[0]?.parts[0]?.image).toEqual(LANDSCAPE);
    expect(parts[1]?.parts[0]?.image).toBeNull();
    expect(parts[1]?.parts[0]?.partIndex).toBe(1);
  });

  it('splits overflowing text across slides instead of shrinking below the minimum size', () => {
    const long = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${words(12)}`).join('\n\n');
    const plans = planSlides(
      [post('hook', 'Hook'), post('long', long), post('cta', 'Follow')],
      measure,
    );
    const longSlides = plans.filter((p) => p.parts[0]?.postId === 'long');
    expect(longSlides.length).toBeGreaterThan(1);
    for (const slide of longSlides) {
      expect(slide.fontSize).toBeGreaterThanOrEqual(MIN_BODY_FONT_SIZE);
      expect(fitFontSize(slide.parts, measure)).toBeDefined();
    }
    // Nothing is lost: every paragraph appears on some slide.
    const joined = longSlides.map((s) => s.parts[0]?.text).join('\n\n');
    for (let i = 0; i < 12; i += 1) expect(joined).toContain(`Paragraph ${i} `);
  });

  it('uses the largest size that fits', () => {
    const plans = planSlides([post('hook', 'Hook')], measure);
    expect(plans[0]?.fontSize).toBe(BODY_FONT_SIZES[0]);
  });
});

describe('slide rules helpers', () => {
  it('classifies short (<150, no picture) and long (>200) posts', () => {
    expect(isShortPost(post('a', 'x'.repeat(149)))).toBe(true);
    expect(isShortPost(post('a', 'x'.repeat(150)))).toBe(false);
    expect(isShortPost(post('a', 'x', LANDSCAPE))).toBe(false);
    expect(isLongPost(post('a', 'x'.repeat(201)))).toBe(true);
    expect(isLongPost(post('a', 'x'.repeat(200)))).toBe(false);
  });

  it('keeps short image text as its own label', () => {
    expect(splitImageLabel({ text: 'Fresh bread daily', image: LANDSCAPE }, measure)).toEqual({
      label: 'Fresh bread daily',
      rest: '',
    });
  });

  it('allows at most three lines of text with a picture', () => {
    const fourLines = words(24); // ~4 lines of 39 characters at 46 px
    expect(fitFontSize([{ text: fourLines, image: LANDSCAPE }], measure)).toBeUndefined();
  });

  it('returns no chunks for empty text and one chunk when it fits', () => {
    expect(splitTextToFit('  ', measure)).toEqual([]);
    expect(splitTextToFit('Fits easily', measure)).toEqual(['Fits easily']);
  });
});
