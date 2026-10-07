import { ConfigurationError } from '../../errors';
import { normaliseTags } from '../images/ingest';
import {
  embedMissing,
  storeStockHit,
  type BusinessScope,
  type LibraryDeps,
} from '../images/library';
import type { StockHit, StockSearch } from '../images/stock';
import type { AspectRatio } from '../providers/interface';
import { publicErrorText } from '../providers/provider-errors';
import type { StockScreen } from './image-relevance';

// BACKLOG 20.26 — stock photos for one slide, fetched on demand when the business's own image
// library has nothing suitable (production 2026-10-03: a library holding one image made every
// slide a plain text card). Sources are tried in stockSourcesFromEnv order (images/stock.ts):
// the primaries (Pexels, Storyblocks, Pixabay — Pixabay is the one configured in production),
// then Unsplash. Each hit is stored exactly as the 20.16 stock layer stores it (storeStockHit):
// Pixabay is copied into our storage with its credit, never hotlinked; Unsplash stays a hotlink
// as its guidelines require, and its use is reported to download_location when the slide is
// filled (populate.ts reportStockUse). Pixabay searches go through its 24 h search cache
// (images/stock-cache.ts) and Pixabay's 100 requests a minute; a run asks one search per slide.
// 25.x: an optional `screen` (image-relevance.ts) sees each source's hits BEFORE any is stored and
// keeps only those that fit the slide, so an unrelated photo never enters the library.

/** Hits asked for per slide search: the first usable one is taken (Pixabay's minimum is 3). */
export const SLIDE_STOCK_PER_PAGE = 3;
/** Pixabay documents a 100-character `q`; other sources accept it as is. */
const MAX_QUERY_CHARS = 100;

export function orientationFor(aspectRatio: AspectRatio): StockSearch['orientation'] {
  if (aspectRatio === '16:9') return 'landscape';
  if (aspectRatio === '1:1') return 'square';
  return 'portrait';
}

export interface SlideStockResult {
  id: string;
  provider: StockHit['provider'];
}

/**
 * The first stock image for `query` that lands in the library and is not in `exclude`, or null
 * (no source configured, every source failed or found nothing usable). Never throws for a
 * provider failure: those are logged and the next source is tried.
 */
export async function stockImageForSlide(
  deps: LibraryDeps,
  scope: BusinessScope,
  input: {
    query: string;
    aspectRatio: AspectRatio;
    exclude: ReadonlySet<string>;
    screen?: StockScreen;
  },
): Promise<SlideStockResult | null> {
  const query = input.query.trim().slice(0, MAX_QUERY_CHARS);
  if (!query) return null;
  let sources;
  try {
    const { primary, fallback } = deps.stock();
    sources = [...primary, ...fallback];
  } catch (err) {
    if (err instanceof ConfigurationError) return null;
    throw err;
  }
  for (const source of sources) {
    let hits: StockHit[];
    try {
      hits = await source.search({
        query,
        perPage: SLIDE_STOCK_PER_PAGE,
        orientation: orientationFor(input.aspectRatio),
        userId: scope.organisationId,
        projectId: scope.businessId,
      });
    } catch (err) {
      deps.logger.warn(
        { provider: source.provider, err: publicErrorText(err) },
        'slide stock search failed; trying the next source',
      );
      continue;
    }
    if (input.screen) hits = await input.screen(query, hits);
    for (const hit of hits) {
      try {
        const outcome = await storeStockHit(deps, scope, source, hit, normaliseTags([query]));
        if (outcome.status !== 'skipped' && !input.exclude.has(outcome.id)) {
          return { id: outcome.id, provider: hit.provider };
        }
      } catch (err) {
        deps.logger.warn(
          { provider: source.provider, err: publicErrorText(err) },
          'slide stock image not stored',
        );
      }
    }
  }
  return null;
}

/** Embed images added during population so later searches find them (best effort). */
export async function embedNewImages(deps: LibraryDeps, scope: BusinessScope): Promise<void> {
  try {
    await embedMissing(deps, scope, 20);
  } catch (err) {
    deps.logger.warn({ err: publicErrorText(err) }, 'new slide images not embedded yet');
  }
}
