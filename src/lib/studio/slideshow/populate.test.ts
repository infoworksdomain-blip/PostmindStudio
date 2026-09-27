import type { ImageLibraryItem, PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../../errors';
import type { LibraryDeps } from '../images/library';
import type { ProviderRunDeps } from '../pipeline/provider-run';
import {
  MAX_GENERATIONS_PER_ORG_PER_DAY,
  MAX_GENERATIONS_PER_RUN,
  MIN_SIMILARITY,
  populateSlideshow,
  type PopulateDeps,
  type PopulateScope,
} from './populate';

vi.mock('../images/library', () => ({
  searchLibrary: vi.fn(),
  generateLibraryImage: vi.fn(),
}));
vi.mock('../pipeline/provider-run', () => ({ runProvider: vi.fn() }));

import { generateLibraryImage, searchLibrary } from '../images/library';
import { runProvider } from '../pipeline/provider-run';

const searchLibraryMock = searchLibrary as unknown as ReturnType<typeof vi.fn>;
const generateLibraryImageMock = generateLibraryImage as unknown as ReturnType<typeof vi.fn>;
const runProviderMock = runProvider as unknown as ReturnType<typeof vi.fn>;

const scope: PopulateScope = {
  organisationId: 'org-1',
  businessId: 'biz-1',
  projectId: 'proj-1',
  planTier: 'STANDARD',
};

interface Row {
  id: string;
  sortOrder: number;
  slideType: string;
  imageAssetId: string | null;
  metadata: Record<string, unknown>;
}

function fakeDb(
  rows: Row[],
  profile: { imageThemes?: string[] } | null = null,
  generatedToday = 0,
) {
  const slideshowSlide = {
    findMany: vi.fn(async () => rows),
    update: vi.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
        id: where.id,
        ...data,
      }),
    ),
  };
  const businessProfile = { findFirst: vi.fn(async () => profile) };
  const imageLibraryItem = {
    update: vi.fn(
      async ({
        where,
      }: {
        where: { id: string };
      }): Promise<Pick<ImageLibraryItem, 'id' | 'sourceProvider' | 'licenseNotes'>> => ({
        id: where.id,
        sourceProvider: null,
        licenseNotes: null,
      }),
    ),
    count: vi.fn(async () => generatedToday),
  };
  const db = { slideshowSlide, businessProfile, imageLibraryItem };
  return { db: db as unknown as PrismaClient, slideshowSlide, businessProfile, imageLibraryItem };
}

function deps(db: PrismaClient, overrides: Partial<PopulateDeps> = {}): PopulateDeps {
  return {
    db,
    library: {} as unknown as LibraryDeps,
    providers: {} as unknown as ProviderRunDeps,
    reportStockUse: vi.fn(async () => undefined),
    ...overrides,
  };
}

function providerJsonResult(json: unknown) {
  return {
    decision: { adapter: { providerId: 'anthropic' } },
    providerJobRowId: 'job-1',
    output: { metadata: { json } },
  };
}

beforeEach(() => {
  searchLibraryMock.mockReset();
  generateLibraryImageMock.mockReset();
  runProviderMock.mockReset();
});

describe('populateSlideshow — text writing', () => {
  it('writes pending text from the topic, mapping hook/items/cta in order', async () => {
    const rows: Row[] = [
      {
        id: 's-hook',
        sortOrder: 0,
        slideType: 'TEXT_CARD',
        imageAssetId: null,
        metadata: { role: 'hook', pendingText: true },
      },
      {
        id: 's-item1',
        sortOrder: 1,
        slideType: 'TEXT_CARD',
        imageAssetId: null,
        metadata: { role: 'body', pendingText: true },
      },
      {
        id: 's-item2',
        sortOrder: 2,
        slideType: 'TEXT_CARD',
        imageAssetId: null,
        metadata: { role: 'body', pendingText: true },
      },
      {
        id: 's-cta',
        sortOrder: 3,
        slideType: 'TEXT_CARD',
        imageAssetId: null,
        metadata: { role: 'cta', pendingText: true },
      },
    ];
    const { db, slideshowSlide } = fakeDb(rows);
    runProviderMock.mockResolvedValue(
      providerJsonResult({ hook: 'Hook line', cta: 'Buy now', items: ['Item one', 'Item two'] }),
    );

    const result = await populateSlideshow(deps(db), scope, {
      topic: 'coffee shop',
      aspectRatio: '9:16',
    });

    expect(result.textWritten).toBe(4);
    expect(result.unfilled).toBe(0);
    expect(slideshowSlide.update).toHaveBeenCalledTimes(4);
    const byId = new Map(
      (slideshowSlide.update as ReturnType<typeof vi.fn>).mock.calls.map((call) => [
        (call[0] as { where: { id: string } }).where.id,
        (call[0] as { data: { metadata: Record<string, unknown> } }).data.metadata,
      ]),
    );
    expect(byId.get('s-hook')).toMatchObject({ text: 'Hook line' });
    expect(byId.get('s-item1')).toMatchObject({ text: 'Item one' });
    expect(byId.get('s-item2')).toMatchObject({ text: 'Item two' });
    expect(byId.get('s-cta')).toMatchObject({ text: 'Buy now' });
  });

  it('reports unfilled and never calls the provider when there is no topic', async () => {
    const rows: Row[] = [
      {
        id: 's-hook',
        sortOrder: 0,
        slideType: 'TEXT_CARD',
        imageAssetId: null,
        metadata: { role: 'hook', pendingText: true },
      },
      {
        id: 's-cta',
        sortOrder: 1,
        slideType: 'TEXT_CARD',
        imageAssetId: null,
        metadata: { role: 'cta', pendingText: true },
      },
    ];
    const { db, slideshowSlide } = fakeDb(rows);

    const result = await populateSlideshow(deps(db), scope, { topic: null, aspectRatio: '9:16' });

    expect(result.unfilled).toBe(2);
    expect(result.textWritten).toBe(0);
    expect(runProviderMock).not.toHaveBeenCalled();
    expect(slideshowSlide.update).not.toHaveBeenCalled();
  });

  it('throws ProviderError when the LLM output fails validation', async () => {
    const rows: Row[] = [
      {
        id: 's-hook',
        sortOrder: 0,
        slideType: 'TEXT_CARD',
        imageAssetId: null,
        metadata: { role: 'hook', pendingText: true },
      },
      {
        id: 's-item1',
        sortOrder: 1,
        slideType: 'TEXT_CARD',
        imageAssetId: null,
        metadata: { role: 'body', pendingText: true },
      },
      {
        id: 's-item2',
        sortOrder: 2,
        slideType: 'TEXT_CARD',
        imageAssetId: null,
        metadata: { role: 'body', pendingText: true },
      },
      {
        id: 's-cta',
        sortOrder: 3,
        slideType: 'TEXT_CARD',
        imageAssetId: null,
        metadata: { role: 'cta', pendingText: true },
      },
    ];
    const { db } = fakeDb(rows);
    // Only one item returned, but two item slides are pending.
    runProviderMock.mockResolvedValue(
      providerJsonResult({ hook: 'Hook line', cta: 'Buy now', items: ['Item one'] }),
    );

    await expect(
      populateSlideshow(deps(db), scope, { topic: 'coffee shop', aspectRatio: '9:16' }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws ProviderError when the LLM output does not match the schema at all', async () => {
    const rows: Row[] = [
      {
        id: 's-hook',
        sortOrder: 0,
        slideType: 'TEXT_CARD',
        imageAssetId: null,
        metadata: { role: 'hook', pendingText: true },
      },
    ];
    const { db } = fakeDb(rows);
    runProviderMock.mockResolvedValue(providerJsonResult({ not: 'valid' }));

    await expect(
      populateSlideshow(deps(db), scope, { topic: 'coffee shop', aspectRatio: '9:16' }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('populateSlideshow — image matching', () => {
  it('matches images above MIN_SIMILARITY and never reuses one already chosen', async () => {
    const rows: Row[] = [
      {
        id: 's-1',
        sortOrder: 0,
        slideType: 'IMAGE_STILL',
        imageAssetId: null,
        metadata: { imageQuery: 'a' },
      },
      {
        id: 's-2',
        sortOrder: 1,
        slideType: 'IMAGE_STILL',
        imageAssetId: null,
        metadata: { imageQuery: 'b' },
      },
    ];
    const { db, slideshowSlide, imageLibraryItem } = fakeDb(rows);
    searchLibraryMock.mockImplementation(async (_deps: unknown, _scope: unknown, query: string) => {
      if (query === 'a') {
        return [
          { id: 'img-1', similarity: 0.5 },
          { id: 'img-2', similarity: 0.4 },
        ];
      }
      return [
        { id: 'img-1', similarity: 0.6 },
        { id: 'img-2', similarity: 0.35 },
      ];
    });
    const reportStockUse = vi.fn(async () => undefined);

    const result = await populateSlideshow(deps(db, { reportStockUse }), scope, {
      topic: null,
      aspectRatio: '9:16',
    });

    expect(result.imagesMatched).toBe(2);
    expect(result.imagesGenerated).toBe(0);
    expect(result.unfilled).toBe(0);
    expect(generateLibraryImageMock).not.toHaveBeenCalled();

    const updatedIds = (slideshowSlide.update as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { data: { imageAssetId: string } }).data.imageAssetId,
    );
    expect(updatedIds).toEqual(['img-1', 'img-2']);
    expect(imageLibraryItem.update).toHaveBeenCalledTimes(2);
    expect(reportStockUse).toHaveBeenCalledTimes(2);
  });

  it('never matches a hit below MIN_SIMILARITY', async () => {
    const rows: Row[] = [
      {
        id: 's-1',
        sortOrder: 0,
        slideType: 'IMAGE_STILL',
        imageAssetId: null,
        metadata: { imageQuery: 'a' },
      },
    ];
    const { db } = fakeDb(rows);
    searchLibraryMock.mockResolvedValue([{ id: 'img-1', similarity: MIN_SIMILARITY - 0.01 }]);
    generateLibraryImageMock.mockResolvedValue({ status: 'created', id: 'gen-1' });

    const result = await populateSlideshow(deps(db), scope, { topic: null, aspectRatio: '9:16' });
    expect(result.imagesMatched).toBe(0);
    // falls through to generation since it's a required (IMAGE_STILL) slide
    expect(result.imagesGenerated).toBe(1);
  });
});

describe('populateSlideshow — image generation', () => {
  it('generates for required (IMAGE_SLIDE_TYPES) slides below threshold but never for optional-image types', async () => {
    const rows: Row[] = [
      {
        id: 's-required',
        sortOrder: 0,
        slideType: 'IMAGE_STILL',
        imageAssetId: null,
        metadata: { imageQuery: 'x' },
      },
      {
        id: 's-optional',
        sortOrder: 1,
        slideType: 'QUOTE',
        imageAssetId: null,
        metadata: { imageQuery: 'y', quote: 'hi' },
      },
    ];
    const { db, slideshowSlide } = fakeDb(rows);
    searchLibraryMock.mockResolvedValue([{ id: 'img-low', similarity: 0.05 }]);
    generateLibraryImageMock.mockResolvedValue({ status: 'created', id: 'gen-required' });

    const result = await populateSlideshow(deps(db), scope, { topic: null, aspectRatio: '9:16' });

    expect(generateLibraryImageMock).toHaveBeenCalledTimes(1);
    expect(generateLibraryImageMock).toHaveBeenCalledWith(
      expect.anything(),
      scope,
      expect.objectContaining({ prompt: 'x' }),
    );
    expect(result.imagesGenerated).toBe(1);
    expect(result.unfilled).toBe(0); // optional QUOTE slide isn't counted as unfilled
    const updatedIds = (slideshowSlide.update as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { where: { id: string } }).where.id,
    );
    expect(updatedIds).toEqual(['s-required']);
  });

  it('caps generation at MAX_GENERATIONS_PER_RUN and marks the excess required slide unfilled', async () => {
    const rows: Row[] = Array.from({ length: MAX_GENERATIONS_PER_RUN + 1 }, (_, i) => ({
      id: `s-${i}`,
      sortOrder: i,
      slideType: 'IMAGE_STILL',
      imageAssetId: null,
      metadata: { imageQuery: `q-${i}` },
    }));
    const { db } = fakeDb(rows);
    searchLibraryMock.mockResolvedValue([]);
    let counter = 0;
    generateLibraryImageMock.mockImplementation(async () => ({
      status: 'created',
      id: `gen-${counter++}`,
    }));

    const result = await populateSlideshow(deps(db), scope, { topic: null, aspectRatio: '9:16' });

    expect(generateLibraryImageMock).toHaveBeenCalledTimes(MAX_GENERATIONS_PER_RUN);
    expect(result.imagesGenerated).toBe(MAX_GENERATIONS_PER_RUN);
    expect(result.unfilled).toBe(1);
  });

  it('reduces the per-run generation budget when close to MAX_GENERATIONS_PER_ORG_PER_DAY', async () => {
    const rows: Row[] = Array.from({ length: 3 }, (_, i) => ({
      id: `s-${i}`,
      sortOrder: i,
      slideType: 'IMAGE_STILL',
      imageAssetId: null,
      metadata: { imageQuery: `q-${i}` },
    }));
    // Only 2 generations left in the daily budget, even though 3 slides need one.
    const { db } = fakeDb(rows, null, MAX_GENERATIONS_PER_ORG_PER_DAY - 2);
    searchLibraryMock.mockResolvedValue([]);
    let counter = 0;
    generateLibraryImageMock.mockImplementation(async () => ({
      status: 'created',
      id: `gen-${counter++}`,
    }));

    const result = await populateSlideshow(deps(db), scope, { topic: null, aspectRatio: '9:16' });

    expect(generateLibraryImageMock).toHaveBeenCalledTimes(2);
    expect(result.imagesGenerated).toBe(2);
    expect(result.unfilled).toBe(1);
  });

  it('never generates for an optional-image slide even when it is the only slide and has no match', async () => {
    const rows: Row[] = [
      {
        id: 's-quote',
        sortOrder: 0,
        slideType: 'QUOTE',
        imageAssetId: null,
        metadata: { imageQuery: 'y', quote: 'hi' },
      },
    ];
    const { db } = fakeDb(rows);
    searchLibraryMock.mockResolvedValue([]);

    const result = await populateSlideshow(deps(db), scope, { topic: null, aspectRatio: '9:16' });

    expect(generateLibraryImageMock).not.toHaveBeenCalled();
    expect(result.imagesGenerated).toBe(0);
    expect(result.unfilled).toBe(0);
  });

  it('skips slides that already have an imageAssetId', async () => {
    const rows: Row[] = [
      {
        id: 's-1',
        sortOrder: 0,
        slideType: 'IMAGE_STILL',
        imageAssetId: 'already-set',
        metadata: {},
      },
    ];
    const { db } = fakeDb(rows);

    const result = await populateSlideshow(deps(db), scope, { topic: null, aspectRatio: '9:16' });

    expect(searchLibraryMock).not.toHaveBeenCalled();
    expect(generateLibraryImageMock).not.toHaveBeenCalled();
    expect(result).toEqual({ textWritten: 0, imagesMatched: 0, imagesGenerated: 0, unfilled: 0 });
  });

  it('calls reportStockUse once per chosen image, passing the updated library item', async () => {
    const rows: Row[] = [
      {
        id: 's-1',
        sortOrder: 0,
        slideType: 'IMAGE_STILL',
        imageAssetId: null,
        metadata: { imageQuery: 'a' },
      },
    ];
    const { db, imageLibraryItem } = fakeDb(rows);
    searchLibraryMock.mockResolvedValue([{ id: 'img-1', similarity: 0.9 }]);
    const chosenItem = { id: 'img-1', sourceProvider: 'unsplash', licenseNotes: 'track:x' };
    imageLibraryItem.update.mockResolvedValue(chosenItem);
    const reportStockUse = vi.fn(async () => undefined);

    await populateSlideshow(deps(db, { reportStockUse }), scope, {
      topic: null,
      aspectRatio: '9:16',
    });

    expect(reportStockUse).toHaveBeenCalledTimes(1);
    expect(reportStockUse).toHaveBeenCalledWith(chosenItem);
  });

  it('falls back to the business profile image themes when there is no topic or slide query', async () => {
    const rows: Row[] = [
      { id: 's-1', sortOrder: 0, slideType: 'IMAGE_STILL', imageAssetId: null, metadata: {} },
    ];
    const { db } = fakeDb(rows, { imageThemes: ['bakery', 'bread', 'coffee', 'extra'] });
    searchLibraryMock.mockResolvedValue([{ id: 'img-1', similarity: 0.9 }]);

    await populateSlideshow(deps(db), scope, { topic: null, aspectRatio: '9:16' });

    expect(searchLibraryMock).toHaveBeenCalledWith(
      expect.anything(),
      scope,
      'bakery bread coffee',
      expect.any(Number),
    );
  });
});
