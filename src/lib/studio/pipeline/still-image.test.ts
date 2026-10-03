import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { ConfigurationError } from '../../errors';
import type { StockImageSource } from '../images/stock';
import type { PipelineDeps } from './deps';
import { stockStillForRefusal, stockStillForScene } from './still-image';

// BACKLOG 20.25 — stock images come before a paid generation (and are all a clip-budget shot
// gets). Stock problems are a miss there, never a failed shot; the 15.W6 refusal path keeps
// surfacing a stock configuration error as before. (Ingest + library: test/golden/clip-budget.)

const scope = {
  organisationId: 'org-1',
  businessId: 'biz-1',
  planTier: 'STANDARD' as const,
  projectId: 'prj-1',
};
const input = { query: 'warm bakery shelf', aspectRatio: '9:16' };

function deps(stock: () => { primary: StockImageSource[]; fallback: StockImageSource[] }) {
  return {
    scan: { stock },
    logger: pino({ level: 'silent' }),
  } as unknown as PipelineDeps;
}

function source(search: StockImageSource['search']): StockImageSource {
  return { provider: 'pexels', search, downloadUrl: async (hit) => hit.imageUrl };
}

describe('stockStillForScene', () => {
  it('no stock key (sources cannot be built) → a miss for a video shot', async () => {
    const d = deps(() => {
      throw new ConfigurationError('PEXELS_API_KEY is not set');
    });
    await expect(stockStillForScene(d, scope, input, 'shot')).resolves.toBeNull();
  });

  it('…but the refusal fallback still reports the configuration error', async () => {
    const d = deps(() => {
      throw new ConfigurationError('PEXELS_API_KEY is not set');
    });
    await expect(stockStillForRefusal(d, scope, input)).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('a failing search moves on; hotlink-only hits are never used', async () => {
    const failing = source(async () => {
      throw new Error('429');
    });
    const hotlinkOnly = source(async () => [
      {
        provider: 'unsplash',
        providerImageId: 'u1',
        imageUrl: 'https://images.unsplash.example/u1.jpg',
        width: 1080,
        height: 1920,
        alt: null,
        pageUrl: null,
        attribution: null,
        storable: false,
      },
    ]);
    const search = vi.spyOn(hotlinkOnly, 'search');
    const d = deps(() => ({ primary: [failing], fallback: [hotlinkOnly] }));
    await expect(stockStillForScene(d, scope, input, 'shot')).resolves.toBeNull();
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'warm bakery shelf', orientation: 'portrait', perPage: 5 }),
    );
  });
});
