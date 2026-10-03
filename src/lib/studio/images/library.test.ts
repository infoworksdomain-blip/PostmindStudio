import type { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { fakePng } from '../../../../test/helpers/png';
import { memoryStorage } from '../../../../test/helpers/memory-storage';
import { NotFoundError, ProviderError, ValidationError } from '../../errors';
import type { ProviderRunResult } from '../pipeline/provider-run';
import { createPixabaySource, type StockHit, type StockImageSource } from './stock';
import {
  EMBEDDING_DIMENSIONS,
  buildStockLayer,
  deleteLibraryImage,
  embedMissing,
  generateLibraryImage,
  libraryDepsFrom,
  searchLibrary,
  storeStockHit,
  type LibraryDeps,
} from './library';

vi.mock('../pipeline/provider-run', () => ({ runProvider: vi.fn() }));
// Unit tests use a fake $queryRaw: resolve pgvector to the "studio" schema without a lookup.
vi.mock('../vector-sql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../vector-sql')>();
  return { ...actual, vectorSql: async () => actual.vectorSqlFor('studio') };
});
import { runProvider } from '../pipeline/provider-run';

const runProviderMock = runProvider as unknown as ReturnType<typeof vi.fn>;

const scope = { organisationId: 'org-1', businessId: 'biz-1', planTier: 'STANDARD' as const };

function fakeImageLibraryItem() {
  return {
    findUnique: vi.fn(async () => null),
    findFirst: vi.fn(async () => null),
    create: vi.fn(async () => ({ id: 'row-1' })),
    findUniqueOrThrow: vi.fn(async () => ({ id: 'winner-1' })),
    upsert: vi.fn(async () => ({ id: 'row-1', createdAt: new Date(0) })),
    delete: vi.fn(async () => ({})),
  };
}

function fakeDb() {
  const imageLibraryItem = fakeImageLibraryItem();
  const imageLibraryQuery = { upsert: vi.fn(async () => ({})) };
  const businessProfile = { findFirst: vi.fn(async () => null) };
  const db = {
    imageLibraryItem,
    imageLibraryQuery,
    businessProfile,
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 0),
  };
  return {
    db: db as unknown as PrismaClient,
    imageLibraryItem,
    imageLibraryQuery,
    businessProfile,
  };
}

function stockSource(
  provider: StockHit['provider'],
  overrides: {
    search?: StockImageSource['search'];
    downloadUrl?: StockImageSource['downloadUrl'];
  } = {},
): StockImageSource & { search: ReturnType<typeof vi.fn>; downloadUrl: ReturnType<typeof vi.fn> } {
  return {
    provider,
    search: vi.fn(overrides.search ?? (async () => [])),
    downloadUrl: vi.fn(overrides.downloadUrl ?? (async (hit: StockHit) => hit.imageUrl)),
  } as StockImageSource & {
    search: ReturnType<typeof vi.fn>;
    downloadUrl: ReturnType<typeof vi.fn>;
  };
}

function storableHit(overrides: Partial<StockHit> = {}): StockHit {
  return {
    provider: 'pexels',
    providerImageId: '1',
    imageUrl: 'https://cdn.example.com/1.jpg',
    width: 1200,
    height: 800,
    alt: 'a loaf',
    pageUrl: 'https://pexels.com/photo/1',
    attribution: { name: 'Jane', url: null },
    storable: true,
    ...overrides,
  };
}

function hotlinkHit(overrides: Partial<StockHit> = {}): StockHit {
  return {
    provider: 'unsplash',
    providerImageId: 'abc',
    imageUrl: 'https://images.unsplash.com/abc',
    width: 1600,
    height: 900,
    alt: 'a loaf',
    pageUrl: 'https://unsplash.com/photos/abc',
    attribution: { name: 'Jamie', url: null },
    storable: false,
    trackUseUrl: 'https://api.unsplash.com/photos/abc/download',
    ...overrides,
  };
}

function libraryDeps(db: PrismaClient, stock: LibraryDeps['stock']): LibraryDeps {
  const { storage } = memoryStorage();
  const fetchImpl = vi.fn(async () => new Response(fakePng(700, 700), { status: 200 }));
  return {
    db,
    storage,
    bucket: 'studio-library-assets',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    providers: {} as LibraryDeps['providers'],
    stock,
    logger: pino({ level: 'silent' }),
  };
}

beforeEach(() => {
  runProviderMock.mockReset();
});

describe('buildStockLayer', () => {
  it('returns an empty result and never calls stock() when there are no queries', async () => {
    const { db } = fakeDb();
    const stock = vi.fn(() => ({ primary: [], fallback: [] }));
    const result = await buildStockLayer(libraryDeps(db, stock), scope, {
      queries: ['  ', ''],
      themes: [],
    });
    expect(result).toEqual({ created: 0, duplicates: 0, skipped: 0, errors: [] });
    expect(stock).not.toHaveBeenCalled();
  });

  it('dedupes the same provider+id hit returned by more than one query', async () => {
    const { db } = fakeDb();
    const hit = storableHit();
    const primary = stockSource('pexels', { search: async () => [hit] });
    const result = await buildStockLayer(
      libraryDeps(db, () => ({ primary: [primary], fallback: [] })),
      scope,
      { queries: ['bread', 'bakery'], themes: [] },
    );
    expect(result.created).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('queries fallback sources only when the primary sources found nothing', async () => {
    const { db } = fakeDb();
    const primaryWithHits = stockSource('pexels', { search: async () => [storableHit()] });
    const fallback = stockSource('unsplash', { search: async () => [hotlinkHit()] });
    await buildStockLayer(
      libraryDeps(db, () => ({ primary: [primaryWithHits], fallback: [fallback] })),
      scope,
      { queries: ['bread'], themes: [] },
    );
    expect(fallback.search).not.toHaveBeenCalled();
  });

  it('falls back to the fallback sources when the primaries return no hits', async () => {
    const { db } = fakeDb();
    const emptyPrimary = stockSource('pexels', { search: async () => [] });
    const fallback = stockSource('unsplash', { search: async () => [hotlinkHit()] });
    const result = await buildStockLayer(
      libraryDeps(db, () => ({ primary: [emptyPrimary], fallback: [fallback] })),
      scope,
      { queries: ['bread'], themes: [] },
    );
    expect(fallback.search).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(1);
  });

  it('collects a per-source, per-query error and continues with other sources', async () => {
    const { db } = fakeDb();
    const failing = stockSource('pexels', {
      search: async () => {
        throw new Error('rate limited');
      },
    });
    const ok = stockSource('storyblocks', {
      search: async () => [storableHit({ provider: 'storyblocks' })],
    });
    const result = await buildStockLayer(
      libraryDeps(db, () => ({ primary: [failing, ok], fallback: [] })),
      scope,
      { queries: ['bread'], themes: [] },
    );
    expect(result.errors).toEqual(['pexels "bread": rate limited']);
    expect(result.created).toBe(1);
  });

  it('routes non-storable (Unsplash) hits through the hotlink path instead of downloading', async () => {
    const { db, imageLibraryItem } = fakeDb();
    const hit = hotlinkHit();
    const source = stockSource('unsplash', { search: async () => [hit] });
    const result = await buildStockLayer(
      libraryDeps(db, () => ({ primary: [source], fallback: [] })),
      scope,
      { queries: ['bread'], themes: [] },
    );
    expect(result.created).toBe(1);
    expect(source.downloadUrl).not.toHaveBeenCalled();
    expect(imageLibraryItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ source: 'STOCK', publicUrl: hit.imageUrl, s3Bucket: '' }),
      }),
    );
  });

  it('downloads and ingests storable hits via source.downloadUrl', async () => {
    const { db, imageLibraryItem } = fakeDb();
    const hit = storableHit();
    const source = stockSource('pexels', { search: async () => [hit] });
    const result = await buildStockLayer(
      libraryDeps(db, () => ({ primary: [source], fallback: [] })),
      scope,
      { queries: ['bread'], themes: [] },
    );
    expect(result.created).toBe(1);
    expect(source.downloadUrl).toHaveBeenCalledTimes(1);
    expect(imageLibraryItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ source: 'STOCK', sourceProvider: 'pexels' }),
      }),
    );
  });

  it('20.16: copies a Pixabay hit into our storage (no hotlink) with Pixabay, user and page credit', async () => {
    const { db, imageLibraryItem } = fakeDb();
    const api = fakeFetch(
      json({
        hits: [
          {
            id: 7,
            pageURL: 'https://pixabay.com/photos/bread-7/',
            tags: 'bread, bakery',
            previewURL: 'https://cdn.pixabay.com/photo/bread-7_150.jpg',
            webformatURL: 'https://pixabay.com/get/bread-7_640.jpg',
            largeImageURL: 'https://pixabay.com/get/bread-7_1280.jpg',
            imageWidth: 2000,
            imageHeight: 2000,
            user: 'Baker',
            user_id: 99,
          },
        ],
      }),
    );
    const source = createPixabaySource('k', { fetchImpl: api.fetch, now: () => 0 });
    const deps = libraryDeps(db, () => ({ primary: [source], fallback: [] }));
    const result = await buildStockLayer(deps, scope, { queries: ['bread'], themes: [] });

    expect(result).toMatchObject({ created: 1, errors: [] });
    // The image bytes are fetched from the 1280 px URL and stored by us.
    const download = (deps.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(download?.[0])).toBe('https://pixabay.com/get/bread-7_1280.jpg');
    const data = (
      imageLibraryItem.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }]
    )[0].data;
    expect(data).toMatchObject({
      source: 'STOCK',
      sourceProvider: 'pixabay',
      sourceUrl: 'https://pixabay.com/photos/bread-7/',
      s3Bucket: 'studio-library-assets',
    });
    expect(String(data.s3Key)).toMatch(/^orgs\/org-1\/businesses\/biz-1\/images\//);
    expect(data.licenseNotes).toBe(
      'Pixabay Content License (https://pixabay.com/service/license-summary/); ' +
        'Photo by Baker (https://pixabay.com/users/Baker-99/); ' +
        'Image from Pixabay: https://pixabay.com/photos/bread-7/',
    );
    // Never the hotlink path.
    expect(imageLibraryItem.upsert).not.toHaveBeenCalled();
  });

  it('upserts the query record with the result count for each provider/query pair', async () => {
    const { db, imageLibraryQuery } = fakeDb();
    const source = stockSource('pexels', { search: async () => [storableHit()] });
    await buildStockLayer(
      libraryDeps(db, () => ({ primary: [source], fallback: [] })),
      scope,
      { queries: ['bread'], themes: [] },
    );
    expect(imageLibraryQuery.upsert).toHaveBeenCalledWith({
      where: {
        businessId_provider_query: { businessId: 'biz-1', provider: 'pexels', query: 'bread' },
      },
      create: { businessId: 'biz-1', provider: 'pexels', query: 'bread', resultCount: 1 },
      update: { resultCount: 1, lastRunAt: expect.any(Date) },
    });
  });

  it('20.26: perQuery asks for and stores at most that many hits per query', async () => {
    const { db } = fakeDb();
    const hits = [1, 2, 3, 4].map((n) => storableHit({ providerImageId: String(n) }));
    const source = stockSource('pixabay', { search: async () => hits });
    await buildStockLayer(
      libraryDeps(db, () => ({ primary: [source], fallback: [] })),
      scope,
      {
        queries: ['bread'],
        themes: [],
        perQuery: 2,
      },
    );
    expect(source.search).toHaveBeenCalledWith(expect.objectContaining({ perPage: 2 }));
    expect(source.downloadUrl).toHaveBeenCalledTimes(2);
  });
});

describe('storeStockHit (20.26, shared with slideshow population)', () => {
  it('copies a storable hit and records a hotlink-only one, both with the licence note', async () => {
    const { db, imageLibraryItem } = fakeDb();
    const deps = libraryDeps(db, () => ({ primary: [], fallback: [] }));
    const pexels = stockSource('pexels');
    const stored = await storeStockHit(deps, scope, pexels, storableHit(), ['bread']);
    expect(stored.status).not.toBe('skipped');
    expect(pexels.downloadUrl).toHaveBeenCalledWith(storableHit(), {
      userId: 'org-1',
      projectId: 'biz-1',
    });

    const unsplash = stockSource('unsplash');
    await storeStockHit(deps, scope, unsplash, hotlinkHit(), ['bread']);
    expect(unsplash.downloadUrl).not.toHaveBeenCalled();
    expect(imageLibraryItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          licenseNotes: expect.stringContaining('track:https://api.unsplash.com/photos/abc'),
        }),
      }),
    );
  });
});

describe('embedMissing', () => {
  it('embeds rows missing an embedding and writes vectors back per row', async () => {
    const { db } = fakeDb();
    (db.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'row-1', altText: 'bread', tags: [], generatedFromPrompt: null },
    ]);
    const vector = new Array(EMBEDDING_DIMENSIONS).fill(0.1);
    runProviderMock.mockResolvedValue({
      decision: { adapter: { providerId: 'openai' } },
      providerJobRowId: 'job-1',
      output: { metadata: { embeddings: [vector], costPence: 3 } },
    } as unknown as ProviderRunResult);

    const result = await embedMissing({ db, providers: {} as LibraryDeps['providers'] }, scope);
    expect(result).toEqual({ embedded: 1, costPence: 3 });
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('skips rows whose embeddingText is empty', async () => {
    const { db } = fakeDb();
    (db.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'row-empty', altText: null, tags: [], generatedFromPrompt: null },
    ]);
    const result = await embedMissing({ db, providers: {} as LibraryDeps['providers'] }, scope);
    expect(result).toEqual({ embedded: 0, costPence: 0 });
    expect(runProviderMock).not.toHaveBeenCalled();
  });

  it('throws ProviderError when the embedding output has the wrong shape', async () => {
    const { db } = fakeDb();
    (db.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'row-1', altText: 'bread', tags: [], generatedFromPrompt: null },
    ]);
    runProviderMock.mockResolvedValue({
      decision: { adapter: { providerId: 'openai' } },
      providerJobRowId: 'job-1',
      output: { metadata: { embeddings: [[1, 2, 3]], costPence: 3 } },
    } as unknown as ProviderRunResult);
    await expect(
      embedMissing({ db, providers: {} as LibraryDeps['providers'] }, scope),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws ProviderError when embeddings count does not match input count', async () => {
    const { db } = fakeDb();
    (db.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'row-1', altText: 'bread', tags: [], generatedFromPrompt: null },
      { id: 'row-2', altText: 'bakery', tags: [], generatedFromPrompt: null },
    ]);
    runProviderMock.mockResolvedValue({
      decision: { adapter: { providerId: 'openai' } },
      providerJobRowId: 'job-1',
      output: { metadata: { embeddings: [new Array(EMBEDDING_DIMENSIONS).fill(0)], costPence: 3 } },
    } as unknown as ProviderRunResult);
    await expect(
      embedMissing({ db, providers: {} as LibraryDeps['providers'] }, scope),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('searchLibrary', () => {
  it('throws ValidationError for an empty (or whitespace-only) query', async () => {
    const { db } = fakeDb();
    await expect(
      searchLibrary({ db, providers: {} as LibraryDeps['providers'] }, scope, '   ', 10),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(runProviderMock).not.toHaveBeenCalled();
  });

  it('embeds the query and maps distance to a 1-distance similarity score', async () => {
    const { db } = fakeDb();
    (db.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'row-1', distance: 0.2 },
    ]);
    runProviderMock.mockResolvedValue({
      decision: { adapter: { providerId: 'openai' } },
      providerJobRowId: 'job-1',
      output: {
        metadata: { embeddings: [new Array(EMBEDDING_DIMENSIONS).fill(0.1)], costPence: 1 },
      },
    } as unknown as ProviderRunResult);

    const hits = await searchLibrary(
      { db, providers: {} as LibraryDeps['providers'] },
      scope,
      'sourdough',
      5,
    );
    expect(hits).toEqual([{ id: 'row-1', similarity: 0.8 }]);
  });
});

describe('generateLibraryImage', () => {
  it('generates via text_to_image, downloads the stored bytes and ingests them', async () => {
    const { db } = fakeDb();
    (db.businessProfile.findFirst as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      subNiche: 'artisan sourdough',
      imageThemes: ['bread', 'bakery'],
    });
    const { storage, objects } = memoryStorage();
    await storage.put({
      bucket: 'assets',
      key: 'generated-1.png',
      body: fakePng(1024, 1024, 1),
      contentType: 'image/png',
    });
    runProviderMock.mockResolvedValue({
      decision: { adapter: { providerId: 'openai' } },
      providerJobRowId: 'job-1',
      output: { metadata: { s3Bucket: 'assets', s3Key: 'generated-1.png', costPence: 4 } },
    } as unknown as ProviderRunResult);

    const deps: LibraryDeps = {
      db,
      storage,
      bucket: 'studio-library-assets',
      fetchImpl: vi.fn() as unknown as typeof fetch,
      providers: {} as LibraryDeps['providers'],
      stock: () => ({ primary: [], fallback: [] }),
      logger: pino({ level: 'silent' }),
    };
    const outcome = await generateLibraryImage(deps, scope, {
      prompt: 'a fresh sourdough loaf',
      aspectRatio: '1:1',
    });
    expect(outcome).toEqual({ status: 'created', id: 'row-1' });
    expect(objects.size).toBe(2); // original generated object + the ingested copy
  });

  it('throws ProviderError when the generation output has no stored location', async () => {
    const { db } = fakeDb();
    runProviderMock.mockResolvedValue({
      decision: { adapter: { providerId: 'openai' } },
      providerJobRowId: 'job-1',
      output: { metadata: {} },
    } as unknown as ProviderRunResult);
    const { storage } = memoryStorage();
    const deps: LibraryDeps = {
      db,
      storage,
      bucket: 'studio-library-assets',
      fetchImpl: vi.fn() as unknown as typeof fetch,
      providers: {} as LibraryDeps['providers'],
      stock: () => ({ primary: [], fallback: [] }),
      logger: pino({ level: 'silent' }),
    };
    await expect(
      generateLibraryImage(deps, scope, { prompt: 'a loaf', aspectRatio: '1:1' }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('deleteLibraryImage', () => {
  it('throws NotFoundError when the row does not exist in the organisation', async () => {
    const { db } = fakeDb();
    const { storage } = memoryStorage();
    await expect(deleteLibraryImage({ db, storage }, 'org-1', 'missing')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('deletes the row and the storage object for a stored image', async () => {
    const { storage, objects } = memoryStorage();
    await storage.put({
      bucket: 'studio-library-assets',
      key: 'orgs/org-1/img.png',
      body: fakePng(600, 600),
      contentType: 'image/png',
    });
    const item = {
      id: 'row-1',
      organisationId: 'org-1',
      s3Bucket: 'studio-library-assets',
      s3Key: 'orgs/org-1/img.png',
    };
    const imageLibraryItem = {
      findFirst: vi.fn(async () => item),
      delete: vi.fn(async () => ({})),
    };
    const db = { imageLibraryItem } as unknown as PrismaClient;
    await deleteLibraryImage({ db, storage }, 'org-1', 'row-1');
    expect(imageLibraryItem.delete).toHaveBeenCalledWith({ where: { id: 'row-1' } });
    expect(objects.has('studio-library-assets/orgs/org-1/img.png')).toBe(false);
  });

  it('skips the storage delete for a hotlinked row with no s3Key', async () => {
    const { storage } = memoryStorage();
    const deleteSpy = vi.spyOn(storage, 'delete');
    const item = { id: 'row-2', organisationId: 'org-1', s3Bucket: '', s3Key: '' };
    const imageLibraryItem = {
      findFirst: vi.fn(async () => item),
      delete: vi.fn(async () => ({})),
    };
    const db = { imageLibraryItem } as unknown as PrismaClient;
    await deleteLibraryImage({ db, storage }, 'org-1', 'row-2');
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});

describe('libraryDepsFrom', () => {
  it('projects the pipeline deps into LibraryDeps', () => {
    const { db } = fakeDb();
    const { storage } = memoryStorage();
    const stock = () => ({ primary: [], fallback: [] });
    const logger = pino({ level: 'silent' });
    const pipeline = {
      db,
      storage,
      config: { assetsBucket: 'assets-bucket' },
      scan: { pageFetch: vi.fn() as unknown as typeof fetch, stock },
      logger,
    } as unknown as Parameters<typeof libraryDepsFrom>[0];
    const deps = libraryDepsFrom(pipeline);
    expect(deps.db).toBe(db);
    expect(deps.storage).toBe(storage);
    expect(deps.bucket).toBe('assets-bucket');
    expect(deps.fetchImpl).toBe(pipeline.scan.pageFetch);
    expect(deps.stock).toBe(stock);
    expect(deps.logger).toBe(logger);
    expect(deps.providers).toBe(pipeline);
  });
});
