import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../errors';
import { costCapsFromEnv, crossedThresholds, percentOf, utcDayKey } from './caps';
import { formatGbp } from './format';

describe('costCapsFromEnv', () => {
  it('treats unset and empty caps as no cap', () => {
    expect(costCapsFromEnv({ STUDIO_GLOBAL_DAILY_CAP_PENCE: '  ' })).toEqual({
      orgProviderDailyPence: undefined,
      orgDailyPenceByTier: {},
      globalDailyPence: undefined,
    });
  });

  it('reads the per-tier organisation caps, the provider cap and the global cap', () => {
    expect(
      costCapsFromEnv({
        STUDIO_ORG_DAILY_CAP_PENCE_BASIC: '500',
        STUDIO_ORG_DAILY_CAP_PENCE_PLUS: '10000',
        STUDIO_ORG_PROVIDER_DAILY_CAP_PENCE: '2000',
        STUDIO_GLOBAL_DAILY_CAP_PENCE: '0',
      }),
    ).toEqual({
      orgProviderDailyPence: 2000,
      orgDailyPenceByTier: { BASIC: 500, PLUS: 10000 },
      globalDailyPence: 0,
    });
  });

  it.each(['-1', '1.5', 'ten', '1e400'])('rejects %s', (value) => {
    expect(() => costCapsFromEnv({ STUDIO_ORG_DAILY_CAP_PENCE_STANDARD: value })).toThrow(
      ConfigurationError,
    );
  });
});

describe('crossedThresholds / percentOf', () => {
  it('returns every threshold reached, inclusive', () => {
    expect(crossedThresholds(79, 100, [80, 90, 100])).toEqual([]);
    expect(crossedThresholds(80, 100, [80, 90, 100])).toEqual([80]);
    expect(crossedThresholds(90, 100, [80, 90, 100])).toEqual([80, 90]);
    expect(crossedThresholds(150, 100, [80, 100])).toEqual([80, 100]);
  });

  it('never alerts on a zero cap (and has no percentage)', () => {
    expect(crossedThresholds(5, 0, [80, 100])).toEqual([]);
    expect(percentOf(5, 0)).toBeNull();
    expect(percentOf(899, 1000)).toBe(89);
  });

  it('formats UTC days and GBP', () => {
    expect(utcDayKey(new Date('2026-09-27T23:59:59Z'))).toBe('2026-09-27');
    expect(formatGbp(123456)).toBe('£1,234.56');
    expect(formatGbp(-5)).toBe('-£0.05');
  });
});
