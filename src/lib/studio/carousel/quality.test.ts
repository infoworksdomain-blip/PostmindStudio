import { describe, expect, it } from 'vitest';
import { SLIDE_WIDTH, THEMES } from './constants';
import type { SlideLayout } from './layout';
import { checkSlide, contrastRatio, isStretched, relativeLuminance, WCAG_AA_TEXT } from './quality';

const base: SlideLayout = {
  width: 1080,
  height: 1350,
  theme: 'light',
  direction: 'ltr',
  background: '#FFFFFF',
  elements: [],
  contentTop: 400,
  contentHeight: 300,
};

const text = (over: Partial<Extract<SlideLayout['elements'][number], { type: 'text' }>>) => ({
  type: 'text' as const,
  role: 'body' as const,
  x: 90,
  y: 400,
  lineHeight: 64,
  text: 'Hello',
  fontSize: 46,
  bold: false,
  colour: '#111418',
  align: 'left' as const,
  width: 200,
  ...over,
});

describe('contrast', () => {
  it('computes WCAG luminance and ratios', () => {
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1);
    expect(relativeLuminance('#000000')).toBe(0);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21);
    expect(() => relativeLuminance('red')).toThrow(RangeError);
  });

  it('every theme colour on its background passes WCAG AA', () => {
    for (const theme of Object.values(THEMES)) {
      expect(contrastRatio(theme.text, theme.background)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
      expect(contrastRatio(theme.handle, theme.background)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
    }
  });
});

describe('isStretched', () => {
  it('allows rounding to whole pixels, not a changed aspect ratio', () => {
    expect(isStretched({ width: 1600, height: 900 }, { width: 900, height: 506 })).toBe(false);
    expect(isStretched({ width: 1600, height: 900 }, { width: 900, height: 900 })).toBe(true);
  });
});

describe('checkSlide', () => {
  it('passes a slide inside the safe area', () => {
    expect(checkSlide({ slide: 0, layout: { ...base, elements: [text({})] } })).toEqual([]);
  });

  it('flags text past the edge using the rendered width', () => {
    const layout = { ...base, elements: [text({})] };
    const issues = checkSlide({ slide: 2, layout, rendered: [{ elementIndex: 0, width: 960 }] });
    expect(issues).toEqual([expect.objectContaining({ slide: 2, code: 'text_outside_safe_area' })]);
  });

  it('flags right-aligned text that runs past the left edge', () => {
    const layout = {
      ...base,
      elements: [text({ align: 'right', x: SLIDE_WIDTH - 90, width: 950 })],
    };
    expect(checkSlide({ slide: 0, layout }).map((i) => i.code)).toContain('text_outside_safe_area');
  });

  it('flags overflow, low contrast and stretched pictures', () => {
    const layout: SlideLayout = {
      ...base,
      contentTop: 100,
      contentHeight: 1200,
      elements: [
        text({ colour: '#DDDDDD' }),
        { type: 'image', x: 90, y: 500, width: 900, height: 900, radius: 28, imageId: 'img' },
      ],
    };
    const codes = checkSlide({
      slide: 0,
      layout,
      sources: new Map([['img', { width: 1600, height: 900 }]]),
    }).map((i) => i.code);
    expect(codes).toEqual(['content_overflow', 'low_contrast', 'image_stretched']);
  });
});
