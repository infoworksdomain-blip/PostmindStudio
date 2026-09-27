import { ValidationError } from '../../errors';
import { extractPage, extractSitemapUrls, type ExtractedPage } from './extract';
import type { PoliteFetcher } from './fetch';

// Addendum A6.2 steps 1–3: homepage (JS-rendered fallback), sitemap, then up to 20 more pages,
// prioritising /about, /products, /shop, /services, stopping early once the site's vocabulary is
// stable (90%+ of the top terms unchanged across consecutive pages).

export const MAX_EXTRA_PAGES = 20;
const PRIORITY_PATHS = ['about', 'product', 'shop', 'service', 'store', 'collection', 'menu'];
const SKIP_EXTENSIONS = /\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|mov|mp3|xml|json|css|js)$/i;
const TOP_TERMS = 30;
const STABILITY = 0.9;
const STABLE_PAGES_TO_STOP = 3;
const STOPWORDS = new Set(
  "the and for with you your our are was this that from have has not but all can will more about into their they them what when where which who how why out get just one also any its it’s it's been than then too very use using over new".split(
    ' ',
  ),
);

/** Renders a JS-heavy page to HTML (e.g. Browserless). */
export interface PageRenderer {
  render(url: string): Promise<string>;
}

export interface CrawlResult {
  pages: ExtractedPage[];
  robotsBlocked: boolean;
  usedJsRender: boolean;
  etag: string | null;
  lastModified: string | null;
  errors: string[];
}

export function priorityOf(url: string): number {
  const path = new URL(url).pathname.toLowerCase();
  const hit = PRIORITY_PATHS.findIndex((p) => path.includes(p));
  const depth = path.split('/').filter(Boolean).length;
  return (hit === -1 ? 100 : hit * 10) + depth;
}

/** Term frequencies of one page (title, description, headings, body). */
export function termCounts(page: ExtractedPage): Map<string, number> {
  const counts = new Map<string, number>();
  const text = [page.title ?? '', page.metaDescription ?? '', ...page.headings, page.bodyText]
    .join(' ')
    .toLowerCase();
  for (const word of text.match(/\p{L}{3,}/gu) ?? []) {
    if (STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

export function topTerms(counts: Map<string, number>, n = TOP_TERMS): Set<string> {
  return new Set(
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, n)
      .map(([w]) => w),
  );
}

function addCounts(into: Map<string, number>, from: Map<string, number>): Map<string, number> {
  const merged = new Map(into);
  for (const [word, n] of from) merged.set(word, (merged.get(word) ?? 0) + n);
  return merged;
}

/** Share of `before` that is still in `after`. */
export function stability(before: Set<string>, after: Set<string>): number {
  if (before.size === 0) return 0;
  let kept = 0;
  for (const term of before) if (after.has(term)) kept += 1;
  return kept / before.size;
}

export async function crawlSite(
  startUrl: string,
  deps: { fetcher: PoliteFetcher; renderer?: PageRenderer },
): Promise<CrawlResult> {
  const result: CrawlResult = {
    pages: [],
    robotsBlocked: false,
    usedJsRender: false,
    etag: null,
    lastModified: null,
    errors: [],
  };

  const home = await deps.fetcher.fetchPage(startUrl);
  if (!home) {
    result.robotsBlocked = true;
    return result;
  }
  if (home.status >= 400) {
    throw new ValidationError(`The website returned HTTP ${home.status} for the homepage`);
  }
  result.etag = home.etag;
  result.lastModified = home.lastModified;
  let homePage = extractPage(home.html, home.url);
  if (homePage.looksJsRendered && deps.renderer) {
    try {
      homePage = extractPage(await deps.renderer.render(home.url), home.url);
      result.usedJsRender = true;
    } catch (err) {
      result.errors.push(`JS render failed: ${(err as Error).message}`.slice(0, 300));
    }
  }
  result.pages.push(homePage);

  // Candidate pages: sitemap(s) plus homepage links, same host, prioritised.
  const candidates = new Set<string>(homePage.links);
  const sitemapUrls = await deps.fetcher.sitemaps(home.url);
  const sitemaps = sitemapUrls.length
    ? sitemapUrls
    : [new URL('/sitemap.xml', home.url).toString()];
  for (const sitemap of sitemaps.slice(0, 2)) {
    try {
      const page = await deps.fetcher.fetchPage(sitemap, 'application/xml,text/xml');
      if (page && page.status < 400)
        for (const url of extractSitemapUrls(page.html, home.url)) candidates.add(url);
    } catch (err) {
      result.errors.push(`sitemap ${sitemap}: ${(err as Error).message}`.slice(0, 300));
    }
  }
  const visited = new Set([home.url, startUrl]);
  const queue = [...candidates]
    .filter((u) => !visited.has(u) && !SKIP_EXTENSIONS.test(new URL(u).pathname))
    .sort((a, b) => priorityOf(a) - priorityOf(b));

  // Site-wide vocabulary: stop once adding pages no longer changes the top terms.
  let aggregate = termCounts(homePage);
  let stableRun = 0;
  for (const url of queue) {
    if (result.pages.length > MAX_EXTRA_PAGES) break;
    if (visited.has(url)) continue;
    visited.add(url);
    try {
      const page = await deps.fetcher.fetchPage(url);
      if (!page || page.status >= 400 || !page.contentType.includes('html')) continue;
      const extracted = extractPage(page.html, page.url);
      result.pages.push(extracted);
      const next = addCounts(aggregate, termCounts(extracted));
      stableRun = stability(topTerms(aggregate), topTerms(next)) >= STABILITY ? stableRun + 1 : 0;
      aggregate = next;
      if (stableRun >= STABLE_PAGES_TO_STOP) break;
    } catch (err) {
      result.errors.push(`${url}: ${(err as Error).message}`.slice(0, 300));
    }
  }
  return result;
}

/** Browserless /content (https://docs.browserless.io/rest-apis/content). */
export function createBrowserlessRenderer(input: {
  token: string;
  fetchImpl: typeof fetch;
  baseUrl?: string;
}): PageRenderer {
  const base = input.baseUrl ?? 'https://production-sfo.browserless.io';
  return {
    async render(url) {
      const res = await input.fetchImpl(
        `${base}/content?token=${encodeURIComponent(input.token)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url }),
          signal: AbortSignal.timeout(45_000),
        },
      );
      if (!res.ok) throw new ValidationError(`Browserless render failed (HTTP ${res.status})`);
      const html = await res.text();
      return html.slice(0, 5 * 1024 * 1024);
    },
  };
}
