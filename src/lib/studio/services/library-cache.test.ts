import type { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '../../tenant';
import { createLibraryCache, type LibraryCache, type LibraryCacheClient } from '../library/cache';
import type { ProviderRunDeps } from '../pipeline/provider-run';
import type { AssetStorage } from '../storage';

// BACKLOG 20.15 — library reads through the shared cache (no repeat DB query, URLs signed per
// response and never cached) and the version bump on every staff write path in this service.

const similarity = vi.hoisted(() => ({
  similarVideos: vi.fn(),
  recommendedVideos: vi.fn(),
}));
vi.mock('../library/similarity', () => similarity);
const search = vi.hoisted(() => ({ searchLibrary: vi.fn() }));
vi.mock('../library/search', () => search);

const {
  adminPatchLibraryVideo,
  getLibraryVideo,
  LIBRARY_RESPONSE_HEADERS,
  libraryBlueprint,
  libraryCategories,
  listCacheKey,
  listLibraryVideos,
  recommendedLibraryVideos,
  retireLibraryVideo,
  searchLibraryVideos,
  similarLibraryVideos,
} = await import('./library');
const { bulkReviewLibraryVideos } = await import('./library-admin');

const silent = pino({ level: 'silent' });
const NOW = Date.UTC(2026, 9, 1, 10);

function memoryClient(): LibraryCacheClient & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value);
      return 'OK';
    },
    incr: async (key) => {
      const next = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(next));
      return next;
    },
  };
}

const row = (id: string) => ({
  id,
  title: `Video ${id}`,
  description: null,
  tags: ['bread'],
  durationSec: 12,
  aspectRatio: '9:16',
  sourcePlatform: null,
  s3Bucket: 'lib',
  thumbnailS3Key: `library/${id}-thumb.jpg`,
  category: { slug: 'food', name: 'Food' },
  analysis: { paceTag: 'fast', moodTag: 'warm', structurePattern: 'hook', shotCount: 3 },
  license: { allowedModes: ['TEMPLATE', 'INSPIRE'], licenseExpires: null as Date | null },
});

function storage(): AssetStorage {
  return {
    signedUrl: vi.fn(
      async (bucket: string, key: string, _ttl?: number, options?: { signingDate?: Date }) =>
        `https://r2.test/${bucket}/${key}?d=${options?.signingDate?.toISOString() ?? 'now'}`,
    ),
  } as unknown as AssetStorage;
}

let client: ReturnType<typeof memoryClient>;
let cache: LibraryCache;
beforeEach(() => {
  client = memoryClient();
  cache = createLibraryCache({ client, logger: silent, counter: { inc: vi.fn() } });
  similarity.similarVideos.mockReset();
  similarity.recommendedVideos.mockReset();
});

describe('cached user reads', () => {
  it('browse: the second identical page is served from the cache', async () => {
    const findMany = vi.fn(async () => [row('a'), row('b')]);
    const db = { videoLibraryItem: { findMany } } as unknown as PrismaClient;
    const deps = { db, storage: storage(), cache, now: () => NOW };
    const query = { limit: 24, tags: ['b', 'a', 'a'] };

    const first = await listLibraryVideos(deps, query);
    const second = await listLibraryVideos(deps, { limit: 24, tags: ['a', 'b'] });

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(first.data[0]).toMatchObject({
      id: 'a',
      allowedModes: ['TEMPLATE', 'INSPIRE'],
      thumbnailUrl: 'https://r2.test/lib/library/a-thumb.jpg?d=2026-10-01T00:00:00.000Z',
    });
    expect(first.data[0]).not.toHaveProperty('s3Bucket');
    expect(first.data[0]).not.toHaveProperty('license');
    // Cached data holds no signed URL.
    expect([...client.store.values()].join()).not.toContain('https://');
    expect(listCacheKey({ limit: 24, tags: ['b', 'a', 'a'] })).toEqual({
      limit: 24,
      tags: ['a', 'b'],
    });
  });

  it('detail: cached without URLs or attribution; preview signed short-lived per request', async () => {
    const findFirst = vi.fn(async () => ({
      ...row('a'),
      s3Key: 'library/a.mp4',
      sourceUrl: 'https://secret.example/a.mp4',
      ingestedAt: new Date('2026-09-01T00:00:00Z'),
      analysis: {
        shotCount: 3,
        hookPattern: 'question',
        structurePattern: 'hook',
        ctaPattern: null,
        paceTag: 'fast',
        moodTag: 'warm',
        transcript: { text: 'the reference script' },
      },
      license: { allowedModes: ['INSPIRE'], licenseExpires: null },
    }));
    const db = { videoLibraryItem: { findFirst } } as unknown as PrismaClient;
    const st = storage();
    const deps = { db, storage: st, cache, now: () => NOW };

    const first = await getLibraryVideo(deps, 'a');
    const second = await getLibraryVideo(deps, 'a');

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ allowedModes: ['INSPIRE'], previewExpiresInSec: 600 });
    expect(first.previewUrl).toBe('https://r2.test/lib/library/a-preview.mp4?d=now');
    for (const hidden of ['sourceUrl', 's3Key', 's3Bucket', 'thumbnailS3Key', 'license', 'licence'])
      expect(first).not.toHaveProperty(hidden);
    expect(first.analysis).not.toHaveProperty('transcript');
    expect(first.ingestedAt).toBe('2026-09-01T00:00:00.000Z');
    const cached = [...client.store.values()].join();
    // The cache holds the trimmed allow-list shape only (A3.10).
    expect(cached).not.toContain('secret.example');
    expect(cached).not.toContain('the reference script');
    expect(cached).not.toContain('https://');
    expect(st.signedUrl).toHaveBeenCalledWith('lib', 'library/a-preview.mp4', 600);
  });

  it('similar: hits and hydration cached; retired rows dropped', async () => {
    similarity.similarVideos.mockResolvedValue([
      { id: 'b', similarity: 0.9 },
      { id: 'gone', similarity: 0.8 },
    ]);
    const findMany = vi.fn(async () => [row('b')]);
    const db = { videoLibraryItem: { findMany } } as unknown as PrismaClient;
    const deps = { db, storage: storage(), cache, now: () => NOW };
    const first = await similarLibraryVideos(deps, 'a', { limit: 12 });
    await similarLibraryVideos(deps, 'a', { limit: 12 });
    expect(similarity.similarVideos).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(first.data).toHaveLength(1);
    expect(first.data[0]).toMatchObject({ id: 'b', similarity: 0.9 });
  });

  it('recommended: cached per organisation and business (no second embedding call)', async () => {
    similarity.recommendedVideos.mockResolvedValue([{ id: 'a', similarity: 0.7 }]);
    const db = {
      videoLibraryItem: { findMany: vi.fn(async () => [row('a')]) },
    } as unknown as PrismaClient;
    const deps = {
      db,
      storage: storage(),
      cache,
      now: () => NOW,
      providers: {} as ProviderRunDeps,
    };
    const tenant = (org: string) =>
      ({ organisationId: org, organisation: { id: org, planTier: 'PLUS' } }) as TenantContext;
    await recommendedLibraryVideos(deps, tenant('o1'), { businessId: 'b1', limit: 12 });
    await recommendedLibraryVideos(deps, tenant('o1'), { businessId: 'b1', limit: 12 });
    expect(similarity.recommendedVideos).toHaveBeenCalledTimes(1);
    await recommendedLibraryVideos(deps, tenant('o2'), { businessId: 'b1', limit: 12 });
    await recommendedLibraryVideos(deps, tenant('o1'), { businessId: 'b2', limit: 12 });
    expect(similarity.recommendedVideos).toHaveBeenCalledTimes(3);
  });

  it('categories and blueprint are cached until the version changes', async () => {
    const categories = vi.fn(async () => [
      { id: 'c', slug: 'food', name: 'Food', parentId: null, depth: 0 },
    ]);
    const findFirst = vi.fn(async () => ({
      id: 'a',
      analysis: {
        shotCount: 1,
        shots: [],
        overlayTimeline: [],
        musicEnvelope: {},
        hookPattern: 'h',
        structurePattern: 's',
        ctaPattern: null,
        paceTag: 'fast',
        moodTag: 'warm',
      },
      license: { allowedModes: ['INSPIRE'], licenseExpires: null },
    }));
    const db = {
      videoLibraryCategory: { findMany: categories },
      videoLibraryItem: { findFirst },
    } as unknown as PrismaClient;
    await libraryCategories(db, cache);
    await libraryCategories(db, cache);
    expect(categories).toHaveBeenCalledTimes(1);
    const bp = await libraryBlueprint(db, 'a', cache);
    await libraryBlueprint(db, 'a', cache);
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(bp).toMatchObject({ libraryVideoId: 'a', blueprint: null });
    await cache.bump('taxonomy-seed');
    await libraryCategories(db, cache);
    expect(categories).toHaveBeenCalledTimes(2);
  });

  it('licence expiry is judged per response, never frozen in the cache', async () => {
    const expires = new Date(NOW + 60_000);
    const findMany = vi.fn(async () => [
      { ...row('a'), license: { allowedModes: ['TEMPLATE', 'INSPIRE'], licenseExpires: expires } },
    ]);
    const db = { videoLibraryItem: { findMany } } as unknown as PrismaClient;
    let t = NOW;
    const deps = { db, storage: storage(), cache, now: () => t };
    expect((await listLibraryVideos(deps, { limit: 24 })).data[0]?.allowedModes).toEqual([
      'TEMPLATE',
      'INSPIRE',
    ]);
    t = NOW + 120_000;
    expect((await listLibraryVideos(deps, { limit: 24 })).data[0]?.allowedModes).toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('blueprint: withheld per response once the licence expires', async () => {
    const analysis = {
      shotCount: 1,
      shots: [],
      overlayTimeline: [],
      musicEnvelope: {},
      hookPattern: 'h',
      structurePattern: 's',
      ctaPattern: null,
      paceTag: 'fast',
      moodTag: 'warm',
    };
    const findFirst = vi.fn(async () => ({
      id: 'a',
      analysis,
      license: { allowedModes: ['TEMPLATE', 'INSPIRE'], licenseExpires: new Date(NOW + 1_000) },
    }));
    const db = { videoLibraryItem: { findFirst } } as unknown as PrismaClient;
    const live = await libraryBlueprint(db, 'a', cache, () => NOW);
    expect(live.allowedModes).toEqual(['TEMPLATE', 'INSPIRE']);
    expect(live.blueprint).not.toBeNull();
    const expired = await libraryBlueprint(db, 'a', cache, () => NOW + 2_000);
    expect(expired).toMatchObject({ allowedModes: [], blueprint: null });
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('search: the key covers the query and every filter (tags order, mood and query case aside)', async () => {
    search.searchLibrary.mockResolvedValue({
      hits: [{ id: 'a', similarity: 0.8, score: 0.9 }],
      nextCursor: null,
    });
    const db = {
      videoLibraryItem: { findMany: vi.fn(async () => [row('a')]) },
    } as unknown as PrismaClient;
    const deps = {
      db,
      storage: storage(),
      cache,
      now: () => NOW,
      providers: {} as ProviderRunDeps,
    };
    const tenant = { organisationId: 'o', organisation: { id: 'o' } } as TenantContext;
    const base = { q: 'Sourdough', limit: 24, tags: ['b', 'a'], mood: 'Warm', durationMin: 5 };
    const first = await searchLibraryVideos(deps, tenant, base);
    await searchLibraryVideos(deps, tenant, {
      ...base,
      q: 'sourdough ',
      tags: ['a', 'b'],
      mood: 'warm',
    });
    expect(search.searchLibrary).toHaveBeenCalledTimes(1);
    expect(first.data[0]).toMatchObject({ id: 'a', score: 0.9 });
    for (const changed of [
      { durationMin: 6 },
      { durationMax: 30 },
      { mood: 'calm' },
      { tags: ['a'] },
      { categorySlug: 'food' },
      { cursor: '24' },
      { limit: 12 },
    ])
      await searchLibraryVideos(deps, tenant, { ...base, ...changed });
    expect(search.searchLibrary).toHaveBeenCalledTimes(8);
  });

  it('without a cache every read goes to the database (pre-20.15 behaviour)', async () => {
    const findMany = vi.fn(async () => [row('a')]);
    const db = { videoLibraryItem: { findMany } } as unknown as PrismaClient;
    await listLibraryVideos({ db, storage: storage() }, { limit: 24 });
    await listLibraryVideos({ db, storage: storage() }, { limit: 24 });
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('GET responses are private and short-lived in the browser', () => {
    expect(LIBRARY_RESPONSE_HEADERS['cache-control']).toBe('private, max-age=60');
  });
});

describe('staff writes bump the catalogue version', () => {
  const bumpSpy = () => ({ read: vi.fn(), embedding: vi.fn(), bump: vi.fn(async () => undefined) });

  it('admin edit (metadata) and licence change', async () => {
    const tx = {
      videoLibraryItem: { update: vi.fn(async () => ({ id: 'a' })) },
      videoLibraryLicense: { upsert: vi.fn(async () => ({})) },
    };
    const db = {
      videoLibraryItem: {
        findUnique: vi.fn(async () => ({ id: 'a', license: { scenario: 'OWNED' } })),
      },
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaClient;
    const spy = bumpSpy();
    await adminPatchLibraryVideo(db, 'a', { title: 'New' }, spy);
    expect(spy.bump).toHaveBeenLastCalledWith('admin-edit');
    await adminPatchLibraryVideo(db, 'a', { licenseScenario: 'SCRAPED' }, spy);
    expect(spy.bump).toHaveBeenLastCalledWith('admin-licence-change');
    expect(spy.bump).toHaveBeenCalledTimes(2);
  });

  it('retire, and not when nothing was retired', async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const db = { videoLibraryItem: { updateMany } } as unknown as PrismaClient;
    const spy = bumpSpy();
    await retireLibraryVideo(db, 'a', NOW, spy);
    expect(spy.bump).toHaveBeenCalledWith('retire');
    await expect(retireLibraryVideo(db, 'a', NOW, spy)).rejects.toThrow('already retired');
    expect(spy.bump).toHaveBeenCalledTimes(1);
  });

  it('bulk review (accept / override / reject)', async () => {
    const tx = { videoLibraryItem: { updateMany: vi.fn(async () => ({ count: 1 })) } };
    const db = {
      videoLibraryItem: { findMany: vi.fn(async () => [{ id: 'a' }]) },
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaClient;
    const spy = bumpSpy();
    await bulkReviewLibraryVideos(
      { db, now: () => NOW, libraryCache: spy },
      { ids: ['a'], action: 'reject' },
    );
    expect(spy.bump).toHaveBeenCalledWith('bulk-reject');
  });
});
