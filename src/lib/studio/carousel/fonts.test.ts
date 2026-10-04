import { describe, expect, it } from 'vitest';
import { parseFontMetrics } from './font-metrics';
import { BOLD_WIDTH_FACTOR, FONT_STACKS, fontStackFor, loadMetrics, measurerFor } from './fonts';

describe('font metrics (public/fonts)', () => {
  it('reads advances and coverage from Inter', () => {
    const inter = loadMetrics({ family: 'Inter', file: 'Inter.ttf' });
    expect(inter.unitsPerEm).toBe(2048);
    expect(inter.advance(0x41)).toBeGreaterThan(0);
    expect(inter.has(0x2192)).toBe(true); // →
    expect(inter.has(0x1f600)).toBe(false); // 😀
    expect(inter.advance(0x1f600)).toBeUndefined();
  });

  it('measures wider text wider and bold wider than regular', () => {
    const { measure } = fontStackFor('en-GB');
    expect(measure('mmmm', 40)).toBeGreaterThan(measure('iiii', 40));
    expect(measure('Acme', 40, true)).toBeCloseTo(measure('Acme', 40) * BOLD_WIDTH_FACTOR);
  });

  it('picks the Noto family for Arabic, Devanagari and Chinese, with Inter after it', () => {
    expect(fontStackFor('ar').faces.map((f) => f.family)).toEqual(['Noto Sans Arabic', 'Inter']);
    expect(fontStackFor('hi').script).toBe('devanagari');
    expect(FONT_STACKS.han[0]?.file).toBe('NotoSansSC.ttf');
    expect(fontStackFor('ar').covered(0x0645)).toBe(true); // م
  });

  it('falls back to a nominal width for characters no font has', () => {
    const { measure, covered } = measurerFor([], 'latin');
    expect(covered(0x41)).toBe(false);
    expect(measure('A', 10)).toBeCloseTo(6);
  });

  it('rejects a buffer that is not a font', () => {
    expect(() => parseFontMetrics(new Uint8Array(64))).toThrow(RangeError);
  });
});
