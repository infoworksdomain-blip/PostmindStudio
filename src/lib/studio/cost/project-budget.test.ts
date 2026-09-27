import { describe, expect, it } from 'vitest';
import {
  budgetFormatsFromJson,
  DEFAULT_LONG_FORM_BUDGET_PENCE,
  DEFAULT_SHORT_FORM_BUDGET_PENCE,
  defaultProjectBudgetPence,
  isLongForm,
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
