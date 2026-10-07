import { describe, expect, it } from 'vitest';
import { contrastRatio, oklchToLinearRgb, parseOklch, relativeLuminance } from './contrast';

describe('parseOklch', () => {
  it('reads lightness, chroma, hue and an optional alpha (number or percent)', () => {
    expect(parseOklch('oklch(0.56 0.2 32)')).toEqual({ l: 0.56, c: 0.2, h: 32, alpha: 1 });
    expect(parseOklch('oklch(1 0 0 / 9%)')).toEqual({ l: 1, c: 0, h: 0, alpha: 0.09 });
    expect(parseOklch('oklch(50% 0.1 200 / 0.5)')).toEqual({ l: 0.5, c: 0.1, h: 200, alpha: 0.5 });
  });

  it('rejects anything that is not oklch()', () => {
    expect(() => parseOklch('#fff')).toThrow(TypeError);
    expect(() => parseOklch('var(--ink)')).toThrow(TypeError);
  });
});

describe('oklchToLinearRgb', () => {
  it('maps the OKLab white and black points to sRGB white and black', () => {
    const white = oklchToLinearRgb(parseOklch('oklch(1 0 0)'));
    white.forEach((c) => expect(c).toBeCloseTo(1, 3));
    expect(oklchToLinearRgb(parseOklch('oklch(0 0 0)'))).toEqual([0, 0, 0]);
  });

  it('gives sRGB red for its published OKLCH value', () => {
    const [r, g, b] = oklchToLinearRgb(parseOklch('oklch(0.62796 0.25768 29.2339)'));
    expect(r).toBeCloseTo(1, 2);
    expect(g).toBeCloseTo(0, 2);
    expect(b).toBeCloseTo(0, 2);
  });
});

describe('contrastRatio', () => {
  it('is 21:1 for black on white and 1:1 for a colour on itself', () => {
    expect(contrastRatio('oklch(0 0 0)', 'oklch(1 0 0)')).toBeCloseTo(21, 1);
    expect(contrastRatio('oklch(0.5 0.1 200)', 'oklch(0.5 0.1 200)')).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    const a = contrastRatio('oklch(0.2 0.01 255)', 'oklch(0.985 0.002 250)');
    const b = contrastRatio('oklch(0.985 0.002 250)', 'oklch(0.2 0.01 255)');
    expect(a).toBeCloseTo(b, 10);
  });

  it('composites a translucent foreground over the background first', () => {
    expect(contrastRatio('oklch(0 0 0 / 0%)', 'oklch(1 0 0)')).toBeCloseTo(1, 5);
    const half = contrastRatio('oklch(0 0 0 / 50%)', 'oklch(1 0 0)');
    expect(half).toBeGreaterThan(3);
    expect(half).toBeLessThan(5);
  });

  it('refuses a translucent background (its result depends on what is behind it)', () => {
    expect(() => contrastRatio('oklch(0 0 0)', 'oklch(1 0 0 / 50%)')).toThrow(TypeError);
  });

  it('agrees with relative luminance for mid grey', () => {
    const grey = oklchToLinearRgb(parseOklch('oklch(0.6 0 0)'));
    expect(relativeLuminance(grey)).toBeGreaterThan(0.2);
    expect(relativeLuminance(grey)).toBeLessThan(0.25);
  });
});
