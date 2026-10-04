import { describe, expect, it } from 'vitest';
import {
  budgetFormatsFromJson,
  DEFAULT_LONG_FORM_BUDGET_PENCE,
  DEFAULT_SHORT_FORM_BUDGET_PENCE,
  DEFAULT_SLIDESHOW_BUDGET_PENCE,
  defaultProjectBudgetPence,
  isLongForm,
  longFormBudgetPence,
  shortFormBudgetPence,
  TIER_BUDGET_FLOOR_PENCE,
} from './project-budget';

describe('defaultProjectBudgetPence (operator decision 2)', () => {
  it('uses the operator values: £3.50 short-form, £30 long-form', () => {
    expect(DEFAULT_SHORT_FORM_BUDGET_PENCE).toBe(350);
    expect(DEFAULT_LONG_FORM_BUDGET_PENCE).toBe(3_000);
  });

  it.each([
    [[{ platform: 'tiktok', durationSec: 30 }], 350],
    [[{ platform: 'tiktok', durationSec: 180 }], 350],
    [[{ platform: 'youtube_short', durationSec: 180 }], 350],
    [[{ platform: 'youtube', durationSec: 60 }], 350],
    [[{ platform: 'linkedin_video', durationSec: 120 }], 350],
    [[{ platform: 'tiktok', durationSec: 181 }], 3_000],
    [[{ platform: 'youtube', durationSec: 61 }], 3_000],
    [[{ platform: 'youtube', durationSec: 300 }], 3_000],
    // Any long-form target makes the whole project long-form.
    [
      [
        { platform: 'tiktok', durationSec: 30 },
        { platform: 'x', durationSec: 600 },
      ],
      3_000,
    ],
    [[], 350],
  ])('%j → %i pence', (formats, expected) => {
    expect(defaultProjectBudgetPence(formats)).toBe(expected);
  });

  it('reads the stored spec 7.3 shape ({ duration }) and ignores malformed entries', () => {
    const stored = budgetFormatsFromJson([
      { platform: 'youtube', aspectRatio: '16:9', duration: 300 },
      { platform: 42 },
      null,
      'tiktok',
    ]);
    expect(stored).toEqual([{ platform: 'youtube', duration: 300 }]);
    expect(isLongForm(stored)).toBe(true);
    expect(budgetFormatsFromJson({ not: 'an array' })).toEqual([]);
    expect(defaultProjectBudgetPence(budgetFormatsFromJson(null))).toBe(350);
  });
});

describe('per-tier defaults (20.25 / 21.3: normal videos never reach the 90% pause)', () => {
  it('short form (21.3 full model at 720p): BASIC and STANDARD £5, PLUS and ENTERPRISE £7', () => {
    expect(shortFormBudgetPence('BASIC')).toBe(500);
    expect(shortFormBudgetPence('STANDARD')).toBe(500);
    expect(shortFormBudgetPence('PLUS')).toBe(700);
    expect(shortFormBudgetPence('ENTERPRISE')).toBe(700);
    expect(shortFormBudgetPence()).toBe(DEFAULT_SHORT_FORM_BUDGET_PENCE);
  });

  it('long form: £30, PLUS and ENTERPRISE £45 (unchanged by 21.3)', () => {
    expect(longFormBudgetPence('BASIC')).toBe(3_000);
    expect(longFormBudgetPence('STANDARD')).toBe(3_000);
    expect(longFormBudgetPence('PLUS')).toBe(4_500);
    expect(longFormBudgetPence('ENTERPRISE')).toBe(4_500);
    expect(longFormBudgetPence()).toBe(DEFAULT_LONG_FORM_BUDGET_PENCE);
  });

  it('the floors raise only the short-form defaults', () => {
    for (const tier of ['BASIC', 'STANDARD', 'PLUS', 'ENTERPRISE'] as const) {
      expect(TIER_BUDGET_FLOOR_PENCE[tier].long).toBe(0);
    }
    expect(TIER_BUDGET_FLOOR_PENCE.ENTERPRISE).toEqual(TIER_BUDGET_FLOOR_PENCE.PLUS);
  });

  it('applies the tier by format and leaves slideshows at £1.50', () => {
    const short = [{ platform: 'tiktok', durationSec: 30 }];
    const long = [{ platform: 'youtube', durationSec: 360 }];
    expect(defaultProjectBudgetPence(short, 'BRIEF', 'STANDARD')).toBe(500);
    expect(defaultProjectBudgetPence(long, 'BRIEF', 'PLUS')).toBe(4_500);
    expect(defaultProjectBudgetPence(short, 'SLIDESHOW', 'PLUS')).toBe(150);
  });
});

describe('slideshow default (15.D2 / A10.4)', () => {
  it('gives SLIDESHOW projects £1.50 whatever their formats; library references follow AI video', () => {
    expect(DEFAULT_SLIDESHOW_BUDGET_PENCE).toBe(150);
    expect(defaultProjectBudgetPence([{ platform: 'tiktok', durationSec: 30 }], 'SLIDESHOW')).toBe(
      150,
    );
    expect(
      defaultProjectBudgetPence([{ platform: 'youtube', durationSec: 600 }], 'SLIDESHOW'),
    ).toBe(150);
    expect(
      defaultProjectBudgetPence([{ platform: 'tiktok', durationSec: 30 }], 'LIBRARY_REFERENCE'),
    ).toBe(350);
  });
});
