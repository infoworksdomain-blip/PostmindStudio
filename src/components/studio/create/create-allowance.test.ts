import { describe, expect, it } from 'vitest';
import type { UsageResponse } from '../usage-meter';
import { allowanceKind, allowanceLine, formatQuarters } from './create-allowance';

const meter = (usedQuarters: number, limitQuarters: number | null, maxDurationSec = 60) => ({
  used: usedQuarters / 4,
  limit: limitQuarters === null ? null : limitQuarters / 4,
  percent: null,
  maxDurationSec,
  usedQuarters,
  limitQuarters,
});

function usage(over: Partial<UsageResponse['usage']> = {}): UsageResponse['usage'] {
  return {
    organisationId: 'org',
    planTier: 'STANDARD',
    mode: 'enforce',
    month: '2026-10',
    periodStart: '2026-10-01T00:00:00Z',
    resetsAt: '2026-11-01T00:00:00Z',
    thresholds: [80, 100],
    status: 'ok',
    videos: { short: meter(78, 96), long: meter(0, 8, 300) },
    platforms: { rule: 'all', description: 'All platforms' },
    scans: { businessesScanned: 0, limit: null },
    ...over,
  };
}

const state = { source: 'BRIEF' as const, platforms: ['tiktok'], length: 'short' as const };

describe('formatQuarters (23.3 quarters of a video)', () => {
  it('counts quick posts ¼, videos 1 and UGC actor videos 2', () => {
    expect(formatQuarters('SLIDESHOW')).toBe(1);
    expect(formatQuarters('CAROUSEL')).toBe(1);
    expect(formatQuarters('WALL_OF_TEXT')).toBe(1);
    expect(formatQuarters('HOOK_DEMO')).toBe(1);
    expect(formatQuarters('BRIEF')).toBe(4);
    expect(formatQuarters('UPLOAD')).toBe(4);
    expect(formatQuarters('UGC')).toBe(8);
  });
});

describe('allowanceKind (plan-quotas videoKind)', () => {
  it('is short for slideshows, carousels and templates; long past the short limit', () => {
    expect(allowanceKind({ ...state, projectTemplate: null }, 60)).toBe('short');
    expect(allowanceKind({ ...state, length: 'long', projectTemplate: null }, 60)).toBe('long');
    expect(
      allowanceKind({ ...state, source: 'SLIDESHOW', length: 'long', projectTemplate: null }, 60),
    ).toBe('short');
    expect(
      allowanceKind(
        { ...state, length: 'long', projectTemplate: { id: 't', name: 'T', platforms: [] } },
        60,
      ),
    ).toBe('short');
    expect(allowanceKind({ ...state, length: 'long', projectTemplate: null }, null)).toBe('short');
  });
});

describe('allowanceLine', () => {
  it('reports what the post uses and what is left of the window', () => {
    expect(allowanceLine({ ...state, projectTemplate: null }, usage())).toEqual({
      usesVideos: 1,
      leftVideos: 4.5,
      limitVideos: 24,
      period: 'month',
    });
    expect(
      allowanceLine(
        { ...state, source: 'CAROUSEL', projectTemplate: null },
        usage({ period: 'week' }),
      ),
    ).toMatchObject({ usesVideos: 0.25, period: 'week' });
  });

  it('reads the long meter for a long video and never goes below zero', () => {
    const line = allowanceLine(
      { ...state, length: 'long', projectTemplate: null },
      usage({ videos: { short: meter(0, 96), long: meter(40, 8, 300) } }),
    );
    expect(line).toMatchObject({ leftVideos: 0, limitVideos: 2 });
  });

  it('omits what is left when unlimited or unknown', () => {
    expect(allowanceLine({ ...state, projectTemplate: null }, undefined)).toEqual({
      usesVideos: 1,
      leftVideos: null,
      limitVideos: null,
      period: 'month',
    });
    const unlimited = usage({ videos: { short: meter(10, null), long: meter(0, null) } });
    expect(allowanceLine({ ...state, projectTemplate: null }, unlimited).leftVideos).toBeNull();
    // 21.5: a per-channel plan has no long-video allowance (0), which is never shown.
    const noLong = usage({ videos: { short: meter(0, 96), long: meter(0, 0, 0) } });
    expect(
      allowanceLine({ ...state, length: 'long', projectTemplate: null }, noLong).leftVideos,
    ).toBeNull();
  });
});
