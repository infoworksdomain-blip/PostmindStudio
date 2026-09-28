import { describe, expect, it } from 'vitest';
import { nearestIndex, niceMax, plot, shortDay } from './chart-utils';
import { fillDays } from './cost-section';

describe('chart utils', () => {
  it('rounds axis ceilings up to 1/2/2.5/5 × 10ⁿ', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(18)).toBe(20);
    expect(niceMax(21)).toBe(25);
    expect(niceMax(420)).toBe(500);
    expect(niceMax(Number.NaN)).toBe(1);
  });

  it('plots points into a 100×100 box', () => {
    const g = plot([
      { label: 'a', value: 0 },
      { label: 'b', value: 10 },
    ]);
    expect(g.max).toBe(10);
    expect(g.coords).toEqual([
      { x: 0, y: 100 },
      { x: 100, y: 0 },
    ]);
    expect(g.line).toBe('M0.00,100.00 L100.00,0.00');
    expect(g.area).toContain('Z');
  });

  it('centres a single point and handles an empty series', () => {
    expect(plot([{ label: 'a', value: 5 }]).coords[0]?.x).toBe(50);
    expect(plot([]).area).toBe('');
  });

  it('finds the nearest point to a pointer position', () => {
    expect(nearestIndex(0.49, 3)).toBe(1);
    expect(nearestIndex(2, 3)).toBe(2);
    expect(nearestIndex(-1, 3)).toBe(0);
    expect(nearestIndex(0.5, 1)).toBe(0);
  });

  it('formats ISO days briefly', () => {
    expect(shortDay('2026-09-27')).toMatch(/^27 Sept?$/);
    expect(shortDay('nope')).toBe('nope');
  });

  it('formats days in the requested locale', () => {
    expect(shortDay('2026-09-27', 'en-US')).toBe('Sep 27');
    expect(shortDay('2026-09-27', 'zh-Hans')).toBe('9月27日');
    expect(shortDay('2026-09-27', 'fr')).toMatch(/^27 sept\.?$/);
  });

  it('fills quiet days with zero spend', () => {
    const now = Date.parse('2026-09-27T12:00:00Z');
    expect(fillDays([{ day: '2026-09-26', costPence: 50 }], 3, now)).toEqual([
      { day: '2026-09-25', costPence: 0 },
      { day: '2026-09-26', costPence: 50 },
      { day: '2026-09-27', costPence: 0 },
    ]);
  });
});

describe('plot minMax', () => {
  it('keeps the axis at least as tall as minMax for an idle series', () => {
    expect(plot([{ label: '1 Sept', value: 0 }], 100).max).toBe(100);
    expect(plot([{ label: '1 Sept', value: 250 }], 100).max).toBe(250);
  });
});
