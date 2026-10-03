import { describe, expect, it } from 'vitest';
import { assertions, videosPerOrganisation } from '../../scripts/load/pipeline-load';
import { cookieHeader } from '../../scripts/load/seed-k6-accounts';
import { summarise, type ProjectOutcome } from '../../src/lib/studio/load-test/report';

// 20.29 load-test scripts: the burst layout, the CI assertions and the session cookie.

describe('pipeline-load', () => {
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
