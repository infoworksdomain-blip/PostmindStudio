import type { ImageLibraryItem, Prisma, PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NoProviderAvailableError, ProviderError } from '../../errors';
import type { LibraryDeps } from '../images/library';
import type { ProviderRunDeps } from '../pipeline/provider-run';
import {
  fillSlideImages,
  MAX_GENERATIONS_PER_ORG_PER_DAY,
  MAX_GENERATIONS_PER_RUN,
  MIN_SIMILARITY,
  populateSlideshow,
  type PopulateDeps,
  type PopulateScope,
} from './populate';
import type { SlideContent } from './planner';

vi.mock('../images/library', () => ({
  searchLibrary: vi.fn(),
  generateLibraryImage: vi.fn(),
}));
vi.mock('../pipeline/provider-run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pipeline/provider-run')>()),
  runProvider: vi.fn(),
}));
vi.mock('./slide-images', () => ({
  stockImageForSlide: vi.fn(async () => null),
  embedNewImages: vi.fn(async () => undefined),
}));

import { generateLibraryImage, searchLibrary } from '../images/library';
import { runProvider } from '../pipeline/provider-run';
import { embedNewImages, stockImageForSlide } from './slide-images';

const searchLibraryMock = searchLibrary as unknown as ReturnType<typeof vi.fn>;
const generateLibraryImageMock = generateLibraryImage as unknown as ReturnType<typeof vi.fn>;
const runProviderMock = runProvider as unknown as ReturnType<typeof vi.fn>;
const stockMock = stockImageForSlide as unknown as ReturnType<typeof vi.fn>;
const embedMock = embedNewImages as unknown as ReturnType<typeof vi.fn>;

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
  generatedThisMonthForBusiness = 0,
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
    // The daily org-wide count has no businessId; the 15.D2 monthly per-business count does.
    count: vi.fn(async (args?: { where?: { businessId?: string } }) =>
      args?.where?.businessId ? generatedThisMonthForBusiness : generatedToday,
    ),
  };
  const db = { slideshowSlide, businessProfile, imageLibraryItem };
  return { db: db as unknown as PrismaClient, slideshowSlide, businessProfile, imageLibraryItem };
}

function deps(db: PrismaClient, overrides: Partial<PopulateDeps> = {}): PopulateDeps {
  return {
    db,
    library: { logger: { warn: vi.fn() } } as unknown as LibraryDeps,
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
  stockMock.mockReset();
  stockMock.mockResolvedValue(null);
  embedMock.mockClear();
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

  it('stops at the business monthly generation cap (15.D2 / A10.4: Standard 50)', async () => {
    const rows: Row[] = Array.from({ length: 3 }, (_, i) => ({
      id: `m-${i}`,
      sortOrder: i,
      slideType: 'IMAGE_STILL',
      imageAssetId: null,
      metadata: { imageQuery: `q-${i}` },
    }));
    const { db } = fakeDb(rows, null, 0, 49);
    searchLibraryMock.mockResolvedValue([]);
    generateLibraryImageMock.mockImplementation(async () => ({ status: 'created', id: 'gen-m' }));

    const result = await populateSlideshow(deps(db), scope, { topic: null, aspectRatio: '9:16' });

    expect(generateLibraryImageMock).toHaveBeenCalledTimes(1);
    expect(result.unfilled).toBe(2);
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
    expect(result).toEqual({
      textWritten: 0,
      imagesMatched: 0,
      imagesStocked: 0,
      imagesGenerated: 0,
      textCards: 0,
      unfilled: 0,
    });
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

    // The visual-query call fails (runProvider resolves nothing): its fallback is the themes.
    await populateSlideshow(deps(db), scope, { topic: null, aspectRatio: '9:16' });

    expect(searchLibraryMock).toHaveBeenCalledWith(
      expect.anything(),
      scope,
      'bakery bread',
      expect.any(Number),
    );
  });
});

// BACKLOG 20.26 — production 2026-10-03: a business library with one image left every slide a
// text card. Population now goes library → stock (Pixabay, then Unsplash) → AI image within the
// budget → (generation runs only) a text card on the brand backdrop.
describe('fillSlideImages — 20.26 on-demand stock and fallbacks', () => {
  const photo = (id: string, text: string) => {
    const metadata = { role: 'body', text, imageQuery: text };
    return {
      id,
      sortOrder: 0,
      slideType: 'IMAGE_KENBURNS',
      imageAssetId: null,
      metadata,
      content: metadata as { role: 'body'; text: string; imageQuery: string },
    };
  };
  const options = { topic: '3 Steps to Nail Your Meeting Opener', aspectRatio: '16:9' as const };
  const calls = (mock: ReturnType<typeof vi.fn>) => mock.mock.calls.map((c) => c[0] as unknown);

  it('empty library → stock fetched for each slide → the slides get those images', async () => {
    const rows = [photo('b1', 'Open with the outcome'), photo('b2', 'Name the decision')];
    const { db, slideshowSlide } = fakeDb(rows);
    runProviderMock.mockResolvedValue(
      providerJsonResult({
        queries: [
          { slide: 1, query: 'business meeting presenter' },
          { slide: 2, query: 'team decision whiteboard' },
        ],
      }),
    );
    searchLibraryMock.mockResolvedValue([]);
    stockMock
      .mockResolvedValueOnce({ id: 'stock-1', provider: 'pixabay' })
      .mockResolvedValueOnce({ id: 'stock-2', provider: 'pixabay' });

    const result = await fillSlideImages(deps(db), scope, rows, {
      ...options,
      textCardFallback: true,
    });

    expect(result).toMatchObject({ imagesMatched: 0, imagesStocked: 2, imagesGenerated: 0 });
    expect(stockMock).toHaveBeenNthCalledWith(1, expect.anything(), scope, {
      query: 'business meeting presenter',
      aspectRatio: '16:9',
      exclude: expect.any(Set),
      screen: expect.any(Function),
    });
    // The second search excludes the image the first slide took.
    const second = stockMock.mock.calls[1]?.[2] as { exclude: Set<string> };
    expect([...second.exclude]).toEqual(['stock-1']);
    expect(calls(slideshowSlide.update)).toEqual([
      { where: { id: 'b1' }, data: { imageAssetId: 'stock-1' } },
      { where: { id: 'b2' }, data: { imageAssetId: 'stock-2' } },
    ]);
    expect(generateLibraryImageMock).not.toHaveBeenCalled();
    expect(embedMock).toHaveBeenCalledTimes(1); // new stock rows become searchable
  });

  it('the business library is tried before stock', async () => {
    const rows = [photo('b1', 'Open with the outcome')];
    const { db } = fakeDb(rows);
    searchLibraryMock.mockResolvedValue([{ id: 'own-1', similarity: 0.8 }]);

    const result = await fillSlideImages(deps(db), scope, rows, options);

    expect(result.imagesMatched).toBe(1);
    expect(stockMock).not.toHaveBeenCalled();
  });

  it('stock fails → an AI image is generated within the budget', async () => {
    const rows = [photo('b1', 'Open with the outcome')];
    const { db, slideshowSlide } = fakeDb(rows);
    searchLibraryMock.mockResolvedValue([]);
    stockMock.mockResolvedValue(null); // every stock source failed or found nothing
    generateLibraryImageMock.mockResolvedValue({ status: 'created', id: 'gen-1' });

    const result = await fillSlideImages(deps(db), scope, rows, {
      ...options,
      textCardFallback: true,
    });

    expect(result).toMatchObject({ imagesStocked: 0, imagesGenerated: 1, textCards: 0 });
    // 25.x: the visual-query call failed (nothing resolved), so the prompt is the fallback:
    // topic + caption, never the bare caption.
    expect(generateLibraryImageMock).toHaveBeenCalledWith(expect.anything(), scope, {
      prompt: '3 Steps to Nail Your Meeting Opener Open with the outcome',
      aspectRatio: '16:9',
    });
    expect(slideshowSlide.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { imageAssetId: 'gen-1' },
    });
  });

  it('stock and AI both fail → a text card (the EDL draws it on the brand backdrop)', async () => {
    const rows = [{ ...photo('b1', 'Open with the outcome'), durationSec: 3.5 }];
    const { db, slideshowSlide } = fakeDb(rows);
    searchLibraryMock.mockRejectedValue(new NoProviderAvailableError('embedding'));
    generateLibraryImageMock.mockRejectedValue(
      new ProviderError('openai', 'insufficient_credits', 'out of credit', false),
    );

    const result = await fillSlideImages(deps(db), scope, rows, {
      ...options,
      textCardFallback: true,
    });

    expect(result).toMatchObject({ imagesGenerated: 0, textCards: 1, unfilled: 0 });
    const update = calls(slideshowSlide.update)[0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(update.where.id).toBe('b1');
    expect(update.data).toMatchObject({
      slideType: 'TEXT_CARD',
      durationSec: 2.5, // clamped to the text-card range
      metadata: { role: 'body', text: 'Open with the outcome' },
    });
    expect(update.data).not.toHaveProperty('backgroundColor'); // null → the brand backdrop
  });

  it('an exhausted generation budget also ends in a text card, never an extra AI image', async () => {
    const rows = [photo('b1', 'Open with the outcome')];
    const { db } = fakeDb(rows, null, MAX_GENERATIONS_PER_ORG_PER_DAY);
    searchLibraryMock.mockResolvedValue([]);

    const result = await fillSlideImages(deps(db), scope, rows, {
      ...options,
      textCardFallback: true,
    });

    expect(generateLibraryImageMock).not.toHaveBeenCalled();
    expect(result.textCards).toBe(1);
  });

  it('without textCardFallback (manual auto-populate) the slide stays unfilled and errors surface', async () => {
    const rows = [photo('b1', 'Open with the outcome')];
    const { db, slideshowSlide } = fakeDb(rows);
    searchLibraryMock.mockResolvedValue([]);
    generateLibraryImageMock.mockResolvedValue({ status: 'skipped', reason: 'filtered' });

    const result = await fillSlideImages(deps(db), scope, rows, options);
    expect(result).toMatchObject({ textCards: 0, unfilled: 1 });
    expect(slideshowSlide.update).not.toHaveBeenCalled();

    searchLibraryMock.mockRejectedValue(new NoProviderAvailableError('embedding'));
    await expect(fillSlideImages(deps(db), scope, rows, options)).rejects.toBeInstanceOf(
      NoProviderAvailableError,
    );
  });

  it('an imageless slide without text is left for the user (no empty text card)', async () => {
    const rows = [{ ...photo('b1', ''), content: { role: 'body' as const, imageQuery: 'bread' } }];
    const { db, slideshowSlide } = fakeDb(rows, null, MAX_GENERATIONS_PER_ORG_PER_DAY);
    searchLibraryMock.mockResolvedValue([]);

    const result = await fillSlideImages(deps(db), scope, rows, {
      ...options,
      textCardFallback: true,
    });
    expect(result).toMatchObject({ textCards: 0, unfilled: 1 });
    expect(slideshowSlide.update).not.toHaveBeenCalled();
  });
});

// BACKLOG 25.x — production 2026-10-07: photo slides were searched by the bare caption (a bakery's
// "Seeded rye with a deep crust" → croissants, a gym's "Coaches who know your name" → puppies).
describe('fillSlideImages — 25.x contextual queries', () => {
  const bakery = {
    imageThemes: ['bakery', 'bread loaves'],
    industry: 'Food & drink',
    subNiche: 'Artisan bakery',
    products: ['sourdough'],
    services: [],
  };
  const slide = (id: string, content: SlideContent) => ({
    id,
    sortOrder: 0,
    slideType: 'IMAGE_KENBURNS',
    imageAssetId: null,
    metadata: { ...content } as Prisma.JsonObject,
    content,
  });
  const options = { topic: 'Why our bread is different', aspectRatio: '9:16' as const };

  it('rewrites a caption-equal imageQuery with ONE light call and searches every source with it', async () => {
    const rows = [
      slide('r1', {
        role: 'body',
        text: 'Seeded rye with a deep crust',
        imageQuery: 'Seeded rye with a deep crust',
      }),
      slide('r2', { role: 'body', text: 'Pastries baked next door' }),
    ];
    const { db } = fakeDb(rows, bakery);
    runProviderMock.mockResolvedValue(
      providerJsonResult({
        queries: [
          { slide: 1, query: 'seeded rye sourdough loaf crust bakery' },
          { slide: 2, query: 'fresh pastries bakery counter' },
        ],
      }),
    );
    searchLibraryMock.mockResolvedValue([]);
    generateLibraryImageMock.mockResolvedValue({ status: 'created', id: 'gen-1' });

    await fillSlideImages(deps(db), scope, rows, { ...options, textCardFallback: true });

    expect(runProviderMock).toHaveBeenCalledTimes(1);
    const request = runProviderMock.mock.calls[0]?.[0].request as { task: string; prompt: string };
    expect(request.task).toBe('slide_image_query');
    expect(request.prompt).toContain('Slideshow topic: Why our bread is different');
    expect(request.prompt).toContain('Business: Artisan bakery — Food & drink');
    const libraryQueries = searchLibraryMock.mock.calls.map((c) => c[2] as string);
    expect(libraryQueries).toEqual([
      'seeded rye sourdough loaf crust bakery',
      'fresh pastries bakery counter',
    ]);
    expect((stockMock.mock.calls[0]?.[2] as { query: string }).query).toBe(
      'seeded rye sourdough loaf crust bakery',
    );
    expect(generateLibraryImageMock).toHaveBeenCalledWith(
      expect.anything(),
      scope,
      expect.objectContaining({ prompt: 'seeded rye sourdough loaf crust bakery' }),
    );
  });

  it('keeps an explicit imageQuery that differs from the caption (no model call)', async () => {
    const rows = [
      slide('k1', { role: 'body', text: 'Weak starter', imageQuery: 'bubbly starter jar' }),
    ];
    const { db } = fakeDb(rows, bakery);
    searchLibraryMock.mockResolvedValue([{ id: 'own-1', similarity: 0.7 }]);

    await fillSlideImages(deps(db), scope, rows, options);

    expect(runProviderMock).not.toHaveBeenCalled();
    expect(searchLibraryMock.mock.calls[0]?.[2]).toBe('bubbly starter jar');
  });

  it('model outage → topic + caption + image themes, never the bare caption', async () => {
    const rows = [slide('o1', { role: 'body', text: 'Seeded rye with a deep crust' })];
    const { db } = fakeDb(rows, bakery);
    runProviderMock.mockRejectedValue(new NoProviderAvailableError('text_generation'));
    searchLibraryMock.mockResolvedValue([{ id: 'own-1', similarity: 0.7 }]);

    await fillSlideImages(deps(db), scope, rows, options);

    expect(searchLibraryMock.mock.calls[0]?.[2]).toBe(
      'Why our bread is different Seeded rye with a deep crust bakery loaves',
    );
  });

  it('passes the relevance screen to the stock search', async () => {
    const rows = [slide('s1', { role: 'body', text: 'Coaches who know your name' })];
    const { db } = fakeDb(rows, bakery);
    runProviderMock.mockResolvedValue(
      providerJsonResult({ queries: [{ slide: 1, query: 'gym coach client' }] }),
    );
    searchLibraryMock.mockResolvedValue([]);
    stockMock.mockResolvedValue({ id: 'stock-1', provider: 'pixabay' });

    const result = await fillSlideImages(deps(db), scope, rows, options);

    expect(result.imagesStocked).toBe(1);
    const screen = (stockMock.mock.calls[0]?.[2] as { screen?: unknown }).screen;
    expect(typeof screen).toBe('function');
  });
});
