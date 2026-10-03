import { describe, expect, it } from 'vitest';
import { assertions, parseAccounts, videosPerOrganisation } from '../../scripts/load/pipeline-load';
import {
  checkBurstArgs,
  maxSpendPence,
  PER_VIDEO_BUDGET_PENCE,
} from '../../scripts/load/real-burst';
import { cookieHeader } from '../../scripts/load/seed-k6-accounts';
import { summarise, type ProjectOutcome } from '../../src/lib/studio/load-test/report';

// 20.29 load-test scripts: the burst layout, the CI assertions and the session cookie.

describe('pipeline-load', () => {
  it('reads simulated provider accounts', () => {
    expect(parseAccounts('seedance=10, kling = 40')).toEqual({ seedance: 10, kling: 40 });
    expect(parseAccounts('')).toEqual({});
    expect(parseAccounts('veo=x,=3,luma=0')).toEqual({});
  });

  it('gives one organisation the heavy share and spreads the rest', () => {
    expect(videosPerOrganisation(50, 10, 0.5)).toEqual([25, 3, 3, 3, 3, 3, 3, 3, 2, 2]);
    expect(videosPerOrganisation(10, 1, 0.5)).toEqual([10]);
    expect(videosPerOrganisation(100, 40, 0).reduce((a, b) => a + b, 0)).toBe(100);
  });

  const outcome = (state: string, reason: string | null = null): ProjectOutcome => ({
    projectId: Math.random().toString(36),
    organisationId: 'o',
    startedAt: 0,
    finishedAt: 1_000,
    finalState: state,
    errorReason: reason,
    costPence: 100,
  });

  it('passes a healthy run', () => {
    const outcomes = Array.from({ length: 10 }, () => outcome('READY_FOR_REVIEW'));
    const providers = {
      seedance: { peak: 3, peakByOrganisation: { o: 2 }, cap: { max: 3, perOrganisation: 2 } },
      veo: { peak: 9, peakByOrganisation: { o: 9 }, cap: null },
    };
    expect(assertions(summarise(outcomes), providers, outcomes)).toEqual([]);
  });

  it('does not count cost-guard pauses as pipeline failures', () => {
    const outcomes = [
      ...Array.from({ length: 6 }, () => outcome('READY_FOR_REVIEW')),
      ...Array.from({ length: 4 }, () => outcome('FAILED', 'cost_cap_paused: daily cap')),
    ];
    expect(assertions(summarise(outcomes), {}, outcomes)).toEqual([]);
  });

  it('flags caps broken, rate-limit failures and unfinished work', () => {
    const outcomes = [
      ...Array.from({ length: 8 }, () => outcome('READY_FOR_REVIEW')),
      outcome('FAILED', 'seedance/rate_limited: busy'),
      outcome('ASSETS_GENERATING'),
    ];
    const providers = {
      seedance: { peak: 4, peakByOrganisation: { o: 3 }, cap: { max: 3, perOrganisation: 2 } },
    };
    const problems = assertions(summarise(outcomes), providers, outcomes);
    expect(problems).toEqual([
      'seedance: 4 in flight over the cap 3',
      'seedance: one organisation held 3 slots over its share 2',
      '1 projects failed on a rate limit',
      'only 8/10 projects reached review',
      'some projects never finished',
    ]);
  });
});

describe('real-burst (Phase 2, not run)', () => {
  const ok = {
    org: 'org',
    business: 'biz',
    videos: 5,
    confirmSpendPence: 2_000,
    fakeProviders: false,
  };

  it('caps the spend at videos × the per-project budget', () => {
    expect(maxSpendPence(5)).toBe(5 * PER_VIDEO_BUDGET_PENCE);
    expect(checkBurstArgs(ok)).toEqual([]);
  });

  it('refuses without an approved spend, ids, a sane size, or with simulated providers', () => {
    expect(
      checkBurstArgs({
        videos: 11,
        confirmSpendPence: 100,
        fakeProviders: true,
      }),
    ).toEqual([
      'STUDIO_FAKE_PROVIDERS is set: this is the real-provider check',
      '--org is required',
      '--business is required',
      '--videos must be 1–10',
      '--confirm-spend-pence must be at least 4400 (videos × 400p cap)',
    ]);
    expect(checkBurstArgs({ ...ok, confirmSpendPence: Number.NaN })).toHaveLength(1);
  });
});

describe('seed-k6-accounts', () => {
  it('turns Set-Cookie headers into one Cookie header', () => {
    expect(
      cookieHeader([
        '__Secure-studio.session_token=abc.def; Path=/; HttpOnly; Secure; SameSite=Lax',
        'studio.session_data=xyz; Path=/',
        'broken',
      ]),
    ).toBe('__Secure-studio.session_token=abc.def; studio.session_data=xyz');
  });
});
