import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../errors';
import {
  costCapsFromEnv,
  crossedThresholds,
  DEFAULT_GLOBAL_DAILY_CAP_PENCE,
  DEFAULT_ORG_DAILY_CAP_PENCE,
  DEFAULT_ORG_MONTHLY_CAP_PENCE,
  percentOf,
  resolveCap,
  utcDayKey,
  utcMonthKey,
  utcMonthRange,
} from './caps';
import { formatGbp } from './format';

describe('costCapsFromEnv', () => {
  it('applies the operator defaults when nothing is set (unset and blank alike)', () => {
    expect(costCapsFromEnv({ STUDIO_GLOBAL_DAILY_CAP_PENCE: '  ' })).toEqual({
      orgProviderDailyPence: undefined,
      orgDailyPenceByTier: { BASIC: 1_000, STANDARD: 3_000, PLUS: 7_500, ENTERPRISE: 40_000 },
      orgMonthlyPenceByTier: { BASIC: 4_000, STANDARD: 15_000, PLUS: 45_000, ENTERPRISE: 300_000 },
      globalDailyPence: 250_000,
      sources: {
        orgDailyByTier: {
          BASIC: 'default',
          STANDARD: 'default',
          PLUS: 'default',
          ENTERPRISE: 'default',
        },
        orgMonthlyByTier: {
          BASIC: 'default',
          STANDARD: 'default',
          PLUS: 'default',
          ENTERPRISE: 'default',
        },
        globalDaily: 'default',
      },
    });
    expect(DEFAULT_ORG_DAILY_CAP_PENCE.STANDARD).toBe(3_000);
    expect(DEFAULT_ORG_MONTHLY_CAP_PENCE.ENTERPRISE).toBe(300_000);
    expect(DEFAULT_GLOBAL_DAILY_CAP_PENCE).toBe(250_000);
  });

  it('lets env override each cap and records the source', () => {
    const caps = costCapsFromEnv({
      STUDIO_ORG_DAILY_CAP_PENCE_BASIC: '500',
      STUDIO_ORG_MONTHLY_CAP_PENCE_PLUS: ' 60000 ',
      STUDIO_ORG_PROVIDER_DAILY_CAP_PENCE: '2000',
      STUDIO_GLOBAL_DAILY_CAP_PENCE: '1000000',
    });
    expect(caps.orgDailyPenceByTier.BASIC).toBe(500);
    expect(caps.orgDailyPenceByTier.PLUS).toBe(7_500);
    expect(caps.orgMonthlyPenceByTier?.PLUS).toBe(60_000);
    expect(caps.orgProviderDailyPence).toBe(2000);
    expect(caps.globalDailyPence).toBe(1_000_000);
    expect(caps.sources?.orgDailyByTier.BASIC).toBe('env');
    expect(caps.sources?.orgDailyByTier.PLUS).toBe('default');
    expect(caps.sources?.orgMonthlyByTier.PLUS).toBe('env');
    expect(caps.sources?.globalDaily).toBe('env');
  });

  it.each(['0', 'none', 'NONE', 'off'])('disables a defaulted cap with %s', (value) => {
    const caps = costCapsFromEnv({
      STUDIO_ORG_DAILY_CAP_PENCE_STANDARD: value,
      STUDIO_ORG_MONTHLY_CAP_PENCE_ENTERPRISE: value,
      STUDIO_GLOBAL_DAILY_CAP_PENCE: value,
    });
    expect(caps.orgDailyPenceByTier.STANDARD).toBeUndefined();
    expect('STANDARD' in caps.orgDailyPenceByTier).toBe(false);
    expect(caps.orgMonthlyPenceByTier?.ENTERPRISE).toBeUndefined();
    expect(caps.globalDailyPence).toBeUndefined();
    expect(caps.sources?.orgDailyByTier.STANDARD).toBe('disabled');
    expect(caps.sources?.orgMonthlyByTier.ENTERPRISE).toBe('disabled');
    expect(caps.sources?.globalDaily).toBe('disabled');
  });

  it('keeps the provider cap without a default (unset = no cap, 0 = a zero cap)', () => {
    expect(costCapsFromEnv({}).orgProviderDailyPence).toBeUndefined();
    expect(
      costCapsFromEnv({ STUDIO_ORG_PROVIDER_DAILY_CAP_PENCE: '0' }).orgProviderDailyPence,
    ).toBe(0);
  });

  it.each(['-1', '1.5', 'ten', '1e400'])('rejects %s', (value) => {
    expect(() => costCapsFromEnv({ STUDIO_ORG_DAILY_CAP_PENCE_STANDARD: value })).toThrow(
      ConfigurationError,
    );
    expect(() => costCapsFromEnv({ STUDIO_ORG_MONTHLY_CAP_PENCE_BASIC: value })).toThrow(
      ConfigurationError,
    );
  });
});

describe('resolveCap', () => {
  it('returns the value and where it came from', () => {
    expect(resolveCap({}, 'X', 7)).toEqual({ pence: 7, source: 'default' });
    expect(resolveCap({ X: '9' }, 'X', 7)).toEqual({ pence: 9, source: 'env' });
    expect(resolveCap({ X: 'Off' }, 'X', 7)).toEqual({ pence: undefined, source: 'disabled' });
  });
});

describe('UTC month helpers', () => {
  it('keys and bounds the calendar month in UTC', () => {
    const late = new Date('2026-09-30T23:59:59Z');
    expect(utcMonthKey(late)).toBe('2026-09');
    expect(utcMonthRange(late)).toEqual({
      start: new Date('2026-09-01T00:00:00Z'),
      end: new Date('2026-10-01T00:00:00Z'),
    });
    expect(utcMonthRange(new Date('2026-12-15T10:00:00Z')).end).toEqual(
      new Date('2027-01-01T00:00:00Z'),
    );
    expect(utcMonthKey(new Date('2026-10-01T00:00:00Z'))).toBe('2026-10');
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
