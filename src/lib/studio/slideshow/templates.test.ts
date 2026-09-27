import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_TEMPLATES,
  SLIDE_DURATION_RANGE,
  clampDuration,
  slideBlueprint,
  slidePlan,
} from './templates';

describe('BUILT_IN_TEMPLATES', () => {
  it('has exactly 8 templates', () => {
    expect(BUILT_IN_TEMPLATES).toHaveLength(8);
  });

  it('has a unique category per template', () => {
    const categories = BUILT_IN_TEMPLATES.map((t) => t.category);
    expect(new Set(categories).size).toBe(categories.length);
  });

  it.each(BUILT_IN_TEMPLATES.map((t) => [t.category, t] as const))(
    '%s: slidePlan parses with the slidePlan schema',
    (_category, template) => {
      const parsed = slidePlan.safeParse(template.slidePlan);
      expect(parsed.success).toBe(true);
    },
  );

  it.each(BUILT_IN_TEMPLATES.map((t) => [t.category, t] as const))(
    '%s: every blueprint duration is inside SLIDE_DURATION_RANGE for its slideType',
    (_category, template) => {
      for (const blueprint of template.slidePlan) {
        const range = SLIDE_DURATION_RANGE[blueprint.slideType];
        expect(blueprint.durationSec).toBeGreaterThanOrEqual(range.min);
        expect(blueprint.durationSec).toBeLessThanOrEqual(range.max);
      }
    },
  );

  it.each(BUILT_IN_TEMPLATES.map((t) => [t.category, t] as const))(
    '%s: defaultDurationPerSlide is a positive number',
    (_category, template) => {
      expect(template.defaultDurationPerSlide).toBeGreaterThan(0);
    },
  );
});

describe('clampDuration', () => {
  it('clamps below the minimum up to the range minimum', () => {
    expect(clampDuration('IMAGE_STILL', 0.1)).toBe(SLIDE_DURATION_RANGE.IMAGE_STILL.min);
  });

  it('clamps above the maximum down to the range maximum', () => {
    expect(clampDuration('QUOTE', 999)).toBe(SLIDE_DURATION_RANGE.QUOTE.max);
  });

  it('rounds to one decimal place within range', () => {
    expect(clampDuration('TEXT_CARD', 2.0001)).toBe(2.0);
    expect(clampDuration('TEXT_CARD', 1.55)).toBeCloseTo(1.6, 5);
  });

  it('leaves an in-range value effectively unchanged (rounded)', () => {
    expect(clampDuration('STATISTIC', 2.5)).toBe(2.5);
  });
});

describe('slideBlueprint repeat refinement', () => {
  const base = {
    role: 'body' as const,
    slideType: 'IMAGE_STILL' as const,
    durationSec: 2,
  };

  it('accepts repeat where min <= max', () => {
    const result = slideBlueprint.safeParse({
      ...base,
      repeat: { source: 'images', min: 3, max: 5 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects repeat where min > max', () => {
    const result = slideBlueprint.safeParse({
      ...base,
      repeat: { source: 'images', min: 10, max: 2 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/repeat\.min must be ≤ repeat\.max/);
    }
  });

  it('rejects an unknown slideType', () => {
    const result = slideBlueprint.safeParse({ ...base, slideType: 'NOT_A_TYPE' });
    expect(result.success).toBe(false);
  });

  it('rejects a durationSec outside [0.5, 10]', () => {
    expect(slideBlueprint.safeParse({ ...base, durationSec: 0.1 }).success).toBe(false);
    expect(slideBlueprint.safeParse({ ...base, durationSec: 11 }).success).toBe(false);
  });
});

describe('slidePlan schema', () => {
  it('rejects an empty array', () => {
    expect(slidePlan.safeParse([]).success).toBe(false);
  });

  it('rejects more than 40 blueprints', () => {
    const one = {
      role: 'body' as const,
      slideType: 'TEXT_CARD' as const,
      durationSec: 2,
    };
    expect(slidePlan.safeParse(new Array(41).fill(one)).success).toBe(false);
  });
});
