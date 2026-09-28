import { describe, expect, it, vi } from 'vitest';
import { ConfigurationError } from '../../errors';
import {
  createProviderRatings,
  DISPLAY_ONLY_PROVIDER_IDS,
  normaliseRetention,
  providerRatingsEnabled,
  RATED_PROVIDER_IDS,
  rateProviders,
  scoreFromComponents,
  scoresOf,
  type AssetEvidence,
  type DecisionEvidence,
  type RenderEvidence,
} from './provider-ratings';

const at = (min: number) => new Date(Date.UTC(2026, 8, 1) + min * 60_000);

function asset(
  id: string,
  source: string,
  opts: Partial<AssetEvidence> & { min?: number } = {},
): AssetEvidence {
  return {
    id,
    shotId: opts.shotId ?? `shot-${id}`,
    scriptId: opts.scriptId ?? 'script-1',
    projectId: opts.projectId ?? 'p1',
    visualTreatment: opts.visualTreatment ?? 'AI_CLIP',
    source,
    createdAt: at(opts.min ?? 0),
  };
}

const many = (provider: string, n: number, projectId = 'p1') =>
  Array.from({ length: n }, (_, i) => asset(`${provider}-${i}`, `${provider}:m`, { projectId }));

describe('scoreFromComponents', () => {
  it.each([
    [{ approvalRate: 1, regenerationRate: 0, retention: 0.6 }, 1],
    [{ approvalRate: 0, regenerationRate: 1, retention: 0.25 }, 0],
    // 0.4·0.5 + 0.3·(1−0.5) + 0.3·norm(0.425 → 0.5) = 0.5
    [{ approvalRate: 0.5, regenerationRate: 0.5, retention: 0.425 }, 0.5],
    // missing components are dropped and the weights renormalised
    [{ approvalRate: 1, regenerationRate: null, retention: null }, 1],
    [{ approvalRate: null, regenerationRate: 0.2, retention: null }, 0.8],
    [{ approvalRate: 0.5, regenerationRate: 0, retention: null }, 0.714],
    [{ approvalRate: null, regenerationRate: null, retention: null }, null],
    // clamped: out-of-range inputs never leave [0, 1]
    [{ approvalRate: 3, regenerationRate: -1, retention: 5 }, 1],
    [{ approvalRate: -2, regenerationRate: 4, retention: -1 }, 0],
  ])('%o → %s', (components, expected) => {
    expect(scoreFromComponents(components)).toBe(expected);
  });

  it('normalises retention on the 25 %–60 % band', () => {
    expect(normaliseRetention(0.1)).toBe(0);
    expect(normaliseRetention(0.25)).toBe(0);
    expect(normaliseRetention(0.6)).toBe(1);
    expect(normaliseRetention(0.95)).toBe(1);
    expect(normaliseRetention(0.425)).toBeCloseTo(0.5);
  });
});

describe('rateProviders', () => {
  const none = { decisions: [] as DecisionEvidence[], renders: [] as RenderEvidence[] };

  it('omits providers below the minimum sample (they stay neutral)', () => {
    const ratings = rateProviders({ assets: [...many('runway', 4), ...many('luma', 5)], ...none });
    expect(ratings.map((r) => r.providerId)).toEqual(['luma']);
    expect(ratings[0]).toMatchObject({
      score: 1,
      sampleShots: 5,
      components: { approvalRate: null, regenerationRate: 0, retention: null },
    });
  });

  it('counts a replaced output (regenerate or swap) against the replaced provider', () => {
    const assets = [
      ...many('luma', 5),
      // shot-luma-0 was regenerated with runway, then swapped for a library image
      asset('r1', 'runway:gen4', { shotId: 'shot-luma-0', min: 10 }),
      asset('lib', 'image-library:abc', { shotId: 'shot-luma-0', min: 20 }),
    ];
    const ratings = rateProviders({ assets, ...none });
    expect(ratings.find((r) => r.providerId === 'luma')?.components.regenerationRate).toBe(0.2);
    // runway (1 output) and image-library (not a provider) are not rated
    expect(ratings.map((r) => r.providerId)).toEqual(['luma']);
  });

  it('credits a human verdict only to outputs live when it was made', () => {
    const assets = [
      ...Array.from({ length: 5 }, (_, i) =>
        asset(`l${i}`, 'luma:ray', { projectId: `p${i}`, min: 0 }),
      ),
      // p0's luma shot was replaced by runway before the approval
      asset('r0', 'runway:gen4', { projectId: 'p0', shotId: 'shot-l0', min: 5 }),
    ];
    const decisions: DecisionEvidence[] = [
      { projectId: 'p0', approved: true, resolvedAt: at(10) },
      { projectId: 'p1', approved: false, resolvedAt: at(10) },
      { projectId: 'p1', approved: true, resolvedAt: at(20) }, // later verdict ignored
      { projectId: 'p2', approved: true, resolvedAt: at(10) },
      { projectId: 'p3', approved: true, resolvedAt: at(10) },
    ];
    const luma = rateProviders({ assets, decisions, renders: [] }).find(
      (r) => r.providerId === 'luma',
    );
    // p1 rejected, p2 + p3 approved; p0's approval went to runway's replacement
    expect(luma?.components.approvalRate).toBe(0.667);
  });

  it('needs MIN_COMPONENT_SAMPLES decisions before approval counts', () => {
    const decisions: DecisionEvidence[] = [
      { projectId: 'p1', approved: false, resolvedAt: at(10) },
    ];
    const [luma] = rateProviders({ assets: many('luma', 2), decisions, renders: [] });
    expect(luma).toBeUndefined();
    const [again] = rateProviders({
      assets: many('luma', 5).map((a, i) => ({ ...a, projectId: i < 2 ? 'p1' : 'px' })),
      decisions,
      renders: [],
    });
    expect(again?.components.approvalRate).toBeNull();
  });

  it('uses the retention of renders built from the shot while it was live', () => {
    const assets = many('luma', 5);
    const renders: RenderEvidence[] = [
      { projectId: 'p1', scriptId: 'script-1', createdAt: at(5), retentions: [0.6, 0.6] },
      { projectId: 'p1', scriptId: 'other', createdAt: at(5), retentions: [0.1] },
      { projectId: 'p1', scriptId: 'script-1', createdAt: at(-5), retentions: [0.1] },
    ];
    const [luma] = rateProviders({ assets, decisions: [], renders });
    expect(luma?.components.retention).toBe(0.6);
    expect(luma?.score).toBe(1);
  });

  it('ignores providers that are not visual shot candidates and non-rated treatments', () => {
    const assets = [
      ...many('elevenlabs', 6),
      ...many('runway', 6).map((a) => ({ ...a, visualTreatment: 'TEXT_CARD' as const })),
    ];
    expect(rateProviders({ assets, ...none })).toEqual([]);
  });

  it('shows shared providers but keeps them out of the router scores', () => {
    expect(RATED_PROVIDER_IDS.has('runway')).toBe(true);
    expect(DISPLAY_ONLY_PROVIDER_IDS.has('openai')).toBe(true);
    expect(DISPLAY_ONLY_PROVIDER_IDS.has('runway')).toBe(false);
    const ratings = rateProviders({
      assets: [
        ...many('openai', 5).map((a) => ({ ...a, visualTreatment: 'IMAGE_STILL' as const })),
        ...many('runway', 5),
      ],
      ...none,
    });
    expect(ratings.find((r) => r.providerId === 'openai')?.routed).toBe(false);
    expect(scoresOf(ratings)).toEqual({ runway: 1 });
  });
});

describe('createProviderRatings', () => {
  function fakeDb() {
    return {
      videoProject: {
        findFirst: vi.fn(async () => ({ businessId: 'biz-1' })),
        findMany: vi.fn(async () => [{ id: 'p1' }]),
      },
      videoAsset: {
        findMany: vi.fn(async () =>
          Array.from({ length: 5 }, (_, i) => ({
            id: `a${i}`,
            shotId: `s${i}`,
            projectId: 'p1',
            source: 'runway:gen4',
            createdAt: at(0),
          })),
        ),
      },
      videoShot: {
        findMany: vi.fn(async () =>
          Array.from({ length: 5 }, (_, i) => ({
            id: `s${i}`,
            scriptId: 'script-1',
            visualTreatment: 'AI_CLIP',
          })),
        ),
      },
      approvalTask: { findMany: vi.fn(async () => []) },
      videoRender: { findMany: vi.fn(async () => []) },
    };
  }
  type Db = Parameters<typeof createProviderRatings>[0]['db'];

  it('caches per business until the TTL expires', async () => {
    const db = fakeDb();
    let now = 0;
    const ratings = createProviderRatings({ db: db as unknown as Db, now: () => now, ttlMs: 1000 });
    expect(await ratings.scoresFor({ organisationId: 'o', projectId: 'p1' })).toEqual({
      runway: 1,
    });
    await ratings.scoresFor({ organisationId: 'o', projectId: 'p1' });
    expect(db.videoAsset.findMany).toHaveBeenCalledTimes(1);
    expect(db.videoProject.findFirst).toHaveBeenCalledTimes(1);
    now = 1001;
    await ratings.scoresFor({ organisationId: 'o', projectId: 'p1' });
    expect(db.videoAsset.findMany).toHaveBeenCalledTimes(2);
  });

  it('returns no scores without a project or for an unknown project', async () => {
    const db = fakeDb();
    db.videoProject.findFirst.mockResolvedValueOnce(null as unknown as { businessId: string });
    const ratings = createProviderRatings({ db: db as unknown as Db, now: () => 0 });
    expect(await ratings.scoresFor({ organisationId: 'o' })).toEqual({});
    expect(await ratings.scoresFor({ organisationId: 'o', projectId: 'gone' })).toEqual({});
    expect(db.videoAsset.findMany).not.toHaveBeenCalled();
  });

  it('does not cache a failed computation', async () => {
    const db = fakeDb();
    db.videoProject.findMany.mockRejectedValueOnce(new Error('db down'));
    const ratings = createProviderRatings({ db: db as unknown as Db, now: () => 0 });
    await expect(ratings.scoresFor({ organisationId: 'o', projectId: 'p1' })).rejects.toThrow();
    expect(await ratings.scoresFor({ organisationId: 'o', projectId: 'p1' })).toEqual({
      runway: 1,
    });
  });
});

describe('providerRatingsEnabled', () => {
  it.each([
    [undefined, true],
    ['', true],
    ['on', true],
    [' ON ', true],
    ['off', false],
  ])('%s → %s', (value, expected) => {
    expect(providerRatingsEnabled(value)).toBe(expected);
  });

  it('rejects anything else', () => {
    expect(() => providerRatingsEnabled('maybe')).toThrow(ConfigurationError);
  });
});
