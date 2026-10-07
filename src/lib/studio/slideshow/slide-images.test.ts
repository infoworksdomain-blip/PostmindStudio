import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationError, ProviderError } from '../../errors';
import type { BusinessScope, LibraryDeps } from '../images/library';
import type { StockHit, StockImageSource } from '../images/stock';

vi.mock('../images/library', () => ({
  storeStockHit: vi.fn(),
  embedMissing: vi.fn(),
}));

import { embedMissing, storeStockHit } from '../images/library';
import {
  embedNewImages,
  orientationFor,
  SLIDE_STOCK_PER_PAGE,
  stockImageForSlide,
} from './slide-images';

const storeMock = storeStockHit as unknown as ReturnType<typeof vi.fn>;
const embedMock = embedMissing as unknown as ReturnType<typeof vi.fn>;

const scope: BusinessScope = { organisationId: 'org-1', businessId: 'biz-1', planTier: 'STANDARD' };

function hit(provider: StockHit['provider'], id: string): StockHit {
  return {
    provider,
    providerImageId: id,
    imageUrl: `https://${provider}.example/${id}.jpg`,
    width: 1280,
    height: 853,
    alt: 'meeting room',
    pageUrl: `https://${provider}.example/photo/${id}`,
    attribution: { name: 'A Photographer', url: null },
    storable: provider !== 'unsplash',
  };
}

function source(
  provider: StockHit['provider'],
  search: StockImageSource['search'],
): StockImageSource {
  return { provider, search: vi.fn(search), downloadUrl: vi.fn(async (h) => h.imageUrl) };
}

function deps(stock: LibraryDeps['stock']): LibraryDeps {
  return {
    stock,
    logger: { warn: vi.fn() },
  } as unknown as LibraryDeps;
}

const input = {
  query: 'Open with the outcome',
  aspectRatio: '9:16' as const,
  exclude: new Set<string>(),
};

beforeEach(() => {
  storeMock.mockReset();
  embedMock.mockReset();
});

describe('stockImageForSlide (20.26)', () => {
  it('searches Pixabay first and stores the hit the 20.16 way (copied, credited)', async () => {
    const pixabay = source('pixabay', async () => [hit('pixabay', 'p1')]);
    const unsplash = source('unsplash', async () => [hit('unsplash', 'u1')]);
    storeMock.mockResolvedValue({ status: 'created', id: 'lib-p1' });

    const result = await stockImageForSlide(
      deps(() => ({ primary: [pixabay], fallback: [unsplash] })),
      scope,
      input,
    );

    expect(result).toEqual({ id: 'lib-p1', provider: 'pixabay' });
    expect(pixabay.search).toHaveBeenCalledWith({
      query: 'Open with the outcome',
      perPage: SLIDE_STOCK_PER_PAGE,
      orientation: 'portrait',
      userId: 'org-1',
      projectId: 'biz-1',
    });
    expect(storeMock).toHaveBeenCalledWith(
      expect.anything(),
      scope,
      pixabay,
      hit('pixabay', 'p1'),
      ['open with the outcome'],
    );
    expect(unsplash.search).not.toHaveBeenCalled();
  });

  it('falls back to Unsplash (a hotlink row) when Pixabay fails', async () => {
    const pixabay = source('pixabay', async () => {
      throw new ProviderError('pixabay', 'rate_limited', 'HTTP 429', true);
    });
    const unsplash = source('unsplash', async () => [hit('unsplash', 'u1')]);
    storeMock.mockResolvedValue({ status: 'created', id: 'lib-u1' });
    const d = deps(() => ({ primary: [pixabay], fallback: [unsplash] }));

    const result = await stockImageForSlide(d, scope, input);

    expect(result).toEqual({ id: 'lib-u1', provider: 'unsplash' });
    expect(storeMock.mock.calls[0]?.[3]).toMatchObject({ provider: 'unsplash', storable: false });
    expect(d.logger.warn).toHaveBeenCalled();
  });

  it('skips images already used in the slideshow and ones the library refuses', async () => {
    const pixabay = source('pixabay', async () => [
      hit('pixabay', 'a'),
      hit('pixabay', 'b'),
      hit('pixabay', 'c'),
    ]);
    storeMock
      .mockResolvedValueOnce({ status: 'duplicate', id: 'used-1' })
      .mockResolvedValueOnce({ status: 'skipped', reason: 'too_small' })
      .mockResolvedValueOnce({ status: 'created', id: 'fresh' });

    const result = await stockImageForSlide(
      deps(() => ({ primary: [pixabay], fallback: [] })),
      scope,
      { ...input, exclude: new Set(['used-1']) },
    );
    expect(result?.id).toBe('fresh');
  });

  it('returns null when every source fails or finds nothing, or a download fails', async () => {
    const empty = source('pixabay', async () => []);
    const broken = source('pexels', async () => [hit('pexels', 'x')]);
    storeMock.mockRejectedValue(new ProviderError('pexels', 'timeout', 'download', true));
    expect(
      await stockImageForSlide(
        deps(() => ({ primary: [broken, empty], fallback: [] })),
        scope,
        input,
      ),
    ).toBeNull();
  });

  it('returns null without a configured stock source, and for an empty query', async () => {
    const notConfigured = deps(() => {
      throw new ConfigurationError('No stock image provider configured');
    });
    expect(await stockImageForSlide(notConfigured, scope, input)).toBeNull();
    expect(await stockImageForSlide(notConfigured, scope, { ...input, query: '  ' })).toBeNull();
  });

  it('trims the query to Pixabay’s documented 100 characters', async () => {
    const pixabay = source('pixabay', async () => []);
    await stockImageForSlide(
      deps(() => ({ primary: [pixabay], fallback: [] })),
      scope,
      {
        ...input,
        query: 'x'.repeat(150),
      },
    );
    expect(vi.mocked(pixabay.search).mock.calls[0]?.[0].query).toHaveLength(100);
  });

  // 25.x: the relevance screen sees the hits before anything is stored.
  it('stores only hits the screen keeps; all rejected → the next source', async () => {
    const pixabay = source('pixabay', async () => [hit('pixabay', 'pup'), hit('pixabay', 'gym')]);
    const unsplash = source('unsplash', async () => [hit('unsplash', 'u1')]);
    storeMock.mockImplementation(async (_d, _s, _src, h: StockHit) => ({
      status: 'created',
      id: `lib-${h.providerImageId}`,
    }));
    const keepGym = vi.fn(async (_q: string, hits: readonly StockHit[]) =>
      hits.filter((h) => h.providerImageId === 'gym'),
    );
    const d = deps(() => ({ primary: [pixabay], fallback: [unsplash] }));

    expect(await stockImageForSlide(d, scope, { ...input, screen: keepGym })).toEqual({
      id: 'lib-gym',
      provider: 'pixabay',
    });
    expect(keepGym).toHaveBeenCalledWith('Open with the outcome', expect.any(Array));
    expect(storeMock).toHaveBeenCalledTimes(1); // the rejected puppy was never stored

    storeMock.mockClear();
    const rejectPixabay = vi.fn(async (_q: string, hits: readonly StockHit[]) =>
      hits.filter((h) => h.provider === 'unsplash'),
    );
    expect(await stockImageForSlide(d, scope, { ...input, screen: rejectPixabay })).toEqual({
      id: 'lib-u1',
      provider: 'unsplash',
    });
    expect(rejectPixabay).toHaveBeenCalledTimes(2);

    const rejectAll = vi.fn(async () => []);
    expect(await stockImageForSlide(d, scope, { ...input, screen: rejectAll })).toBeNull();
  });

  it('maps aspect ratios to stock orientations', () => {
    expect(orientationFor('16:9')).toBe('landscape');
    expect(orientationFor('1:1')).toBe('square');
    expect(orientationFor('9:16')).toBe('portrait');
    expect(orientationFor('4:5')).toBe('portrait');
  });
});

describe('embedNewImages', () => {
  it('embeds new rows and never throws when the embedding provider is down', async () => {
    embedMock.mockRejectedValueOnce(new ProviderError('openai', 'timeout', 'down', true));
    const d = deps(() => ({ primary: [], fallback: [] }));
    await expect(embedNewImages(d, scope)).resolves.toBeUndefined();
    expect(embedMock).toHaveBeenCalledWith(d, scope, 20);
    expect(d.logger.warn).toHaveBeenCalled();
  });
});
