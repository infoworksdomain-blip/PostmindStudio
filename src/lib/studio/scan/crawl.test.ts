import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../errors';
import { fakeFetch } from '../../../../test/helpers/fake-fetch';
import type { FetchedPage, PoliteFetcher } from './fetch';
import type { PageRenderer } from './crawl';
import {
  MAX_EXTRA_PAGES,
  createBrowserlessRenderer,
  crawlSite,
  priorityOf,
  stability,
  termCounts,
  topTerms,
} from './crawl';
import type { ExtractedPage } from './extract';

function page(overrides: Partial<FetchedPage> & { url: string }): FetchedPage {
  return {
    status: 200,
    contentType: 'text/html',
    html: '<html><body>page</body></html>',
    etag: null,
    lastModified: null,
    truncated: false,
    ...overrides,
  };
}

// crawlSite only calls fetchPage() and sitemaps() on its `fetcher` dependency, so a minimal
// stub is cast to PoliteFetcher rather than constructing a real one (which requires its own
// fetchImpl/sleep/now deps and would re-test PoliteFetcher's own behaviour, covered in
// fetch.test.ts).
function asFetcher(stub: {
  fetchPage: (url: string, accept?: string) => Promise<FetchedPage | null>;
  sitemaps: (url: string) => Promise<string[]>;
}): PoliteFetcher {
  return stub as unknown as PoliteFetcher;
}

function fakeFetcher(
  fetchPageImpl: (url: string, accept?: string) => Promise<FetchedPage | null>,
  sitemapsImpl: (url: string) => Promise<string[]> = async () => [],
): PoliteFetcher {
  return asFetcher({
    fetchPage: vi.fn(fetchPageImpl),
    sitemaps: vi.fn(sitemapsImpl),
  });
}

describe('priorityOf', () => {
  it('ranks priority-path pages ahead of others, shallower first', () => {
    expect(priorityOf('https://example.com/products/x')).toBeLessThan(
      priorityOf('https://example.com/blog/post'),
    );
  });

  it('ranks a shallower priority page ahead of a deeper one', () => {
    expect(priorityOf('https://example.com/about')).toBeLessThan(
      priorityOf('https://example.com/about/team/bio'),
    );
  });

  it('gives non-priority paths a base score of 100 plus depth', () => {
    expect(priorityOf('https://example.com/blog')).toBe(101);
    expect(priorityOf('https://example.com/blog/post')).toBe(102);
  });
});

describe('termCounts / topTerms / stability', () => {
  function extracted(text: string): ExtractedPage {
    return {
      url: 'https://example.com/',
      title: null,
      metaDescription: null,
      openGraph: {},
      twitter: {},
      headings: [],
      bodyText: text,
      images: [],
      jsonLd: [],
      links: [],
      looksJsRendered: false,
    };
  }

  it('counts words, excluding stopwords and words shorter than 3 letters', () => {
    const counts = termCounts(extracted('the cat sat on a mat and the cat ran'));
    expect(counts.get('cat')).toBe(2);
    expect(counts.get('the')).toBeUndefined();
    expect(counts.get('mat')).toBe(1);
  });

  it('topTerms returns the n most frequent words, ties broken alphabetically', () => {
    const counts = termCounts(extracted('zebra zebra apple apple banana'));
    expect(topTerms(counts, 2)).toEqual(new Set(['apple', 'zebra']));
  });

  it('stability is 1 when every term in "before" is still in "after"', () => {
    expect(stability(new Set(['a', 'b']), new Set(['a', 'b', 'c']))).toBe(1);
  });

  it('stability is 0 for an empty "before" set', () => {
    expect(stability(new Set(), new Set(['a']))).toBe(0);
  });

  it('stability is the fraction of "before" terms retained in "after"', () => {
    expect(stability(new Set(['a', 'b', 'c', 'd']), new Set(['a', 'b']))).toBe(0.5);
  });
});

describe('crawlSite', () => {
  it('reports robotsBlocked and returns no pages when the homepage fetch is disallowed', async () => {
    const fetcher = fakeFetcher(async () => null);
    const result = await crawlSite('https://example.com/', { fetcher });
    expect(result.robotsBlocked).toBe(true);
    expect(result.pages).toEqual([]);
  });

  it('throws ValidationError when the homepage returns a 4xx status', async () => {
    const fetcher = fakeFetcher(async () => page({ url: 'https://example.com/', status: 404 }));
    await expect(crawlSite('https://example.com/', { fetcher })).rejects.toThrow(ValidationError);
  });

  it('falls back to a JS renderer when the homepage looks JS-rendered', async () => {
    const scripts = Array.from({ length: 6 }, (_, i) => `<script>a${i}</script>`).join('');
    const jsHtml = `<html><body>${scripts}<div id="root"></div></body></html>`;
    const renderedHtml = `<html><body><main>${'word '.repeat(100)}</main></body></html>`;
    const fetcher = fakeFetcher(async () => page({ url: 'https://example.com/', html: jsHtml }));
    const renderer: PageRenderer = { render: vi.fn(async () => renderedHtml) };
    const result = await crawlSite('https://example.com/', { fetcher, renderer });
    expect(result.usedJsRender).toBe(true);
    expect(result.pages[0]?.bodyText).toContain('word');
    expect(result.errors).toEqual([]);
  });

  it('records an error and keeps the unrendered page when the JS renderer fails', async () => {
    const scripts = Array.from({ length: 6 }, (_, i) => `<script>a${i}</script>`).join('');
    const jsHtml = `<html><body>${scripts}<div id="root"></div></body></html>`;
    const fetcher = fakeFetcher(async () => page({ url: 'https://example.com/', html: jsHtml }));
    const renderer: PageRenderer = {
      render: vi.fn(async () => {
        throw new Error('render service down');
      }),
    };
    const result = await crawlSite('https://example.com/', { fetcher, renderer });
    expect(result.usedJsRender).toBe(false);
    expect(result.errors[0]).toContain('JS render failed: render service down');
    expect(result.pages).toHaveLength(1);
  });

  it('prioritises sitemap and priority-path candidates over other homepage links', async () => {
    const homeHtml = `<html><body>
      <a href="https://example.com/blog/post">blog</a>
      <a href="https://example.com/products/widget">widget</a>
    </body></html>`;
    const calls: string[] = [];
    const fetcher = asFetcher({
      fetchPage: vi.fn(async (url: string) => {
        calls.push(url);
        if (url === 'https://example.com/') return page({ url, html: homeHtml });
        if (url === 'https://example.com/sitemap.xml') return null;
        return page({ url, html: `<html><body>${url}</body></html>` });
      }),
      sitemaps: vi.fn(async () => []),
    });
    await crawlSite('https://example.com/', { fetcher });
    // Homepage first, then the sitemap.xml probe, then priority-path pages before the blog page.
    expect(calls[0]).toBe('https://example.com/');
    expect(calls[1]).toBe('https://example.com/sitemap.xml');
    const widgetIndex = calls.indexOf('https://example.com/products/widget');
    const blogIndex = calls.indexOf('https://example.com/blog/post');
    expect(widgetIndex).toBeGreaterThan(-1);
    expect(blogIndex).toBeGreaterThan(-1);
    expect(widgetIndex).toBeLessThan(blogIndex);
  });

  it('includes sitemap URLs as crawl candidates', async () => {
    const stub = {
      fetchPage: vi.fn(async (_url: string, _accept?: string): Promise<FetchedPage | null> => null),
      sitemaps: vi.fn(async () => ['https://example.com/sitemap-index.xml']),
    };
    // fetchPage for the sitemap URL itself returns XML content with one <loc>.
    stub.fetchPage.mockImplementation(async (url: string) => {
      if (url === 'https://example.com/')
        return page({ url, html: '<html><body>home</body></html>' });
      if (url === 'https://example.com/sitemap-index.xml') {
        return page({
          url,
          contentType: 'application/xml',
          html: '<urlset><url><loc>https://example.com/from-sitemap</loc></url></urlset>',
        });
      }
      if (url === 'https://example.com/from-sitemap') {
        return page({ url, html: '<html><body>from sitemap</body></html>' });
      }
      return null;
    });
    const result = await crawlSite('https://example.com/', { fetcher: asFetcher(stub) });
    expect(result.pages.map((p) => p.url)).toContain('https://example.com/from-sitemap');
  });

  it('caps the number of extra pages fetched at MAX_EXTRA_PAGES', async () => {
    const homeHtml = `<html><body>${Array.from(
      { length: MAX_EXTRA_PAGES + 10 },
      (_, i) => `<a href="https://example.com/page-${i}">p${i}</a>`,
    ).join('')}</body></html>`;
    const fetcher = asFetcher({
      fetchPage: vi.fn(async (url: string) => {
        if (url === 'https://example.com/') return page({ url, html: homeHtml });
        if (url === 'https://example.com/sitemap.xml') return null;
        // Each page's vocabulary is 10 unique words whose frequency strictly increases per
        // page (idx + 2), so the top-30 terms become a rolling window of the last three
        // pages' words — consecutive top-term sets only ever overlap ~67%, below the 90%
        // stability threshold, so the crawl never stops early. Word bodies must be
        // letters-only — termCounts matches \p{L}{3,}, so digits would split them up. The
        // total text also stays well under the 5000-char body cap so no word gets dropped.
        const letters = (n: number) =>
          String.fromCharCode(97 + (n % 26)) + String.fromCharCode(97 + Math.floor(n / 26));
        const idx = Number(url.split('-').pop());
        const repeatCount = idx + 2;
        const words = Array.from({ length: 10 }, (_, w) => `pg${letters(idx)}term${letters(w)}`);
        const text = words.map((w) => Array(repeatCount).fill(w).join(' ')).join(' ');
        return page({ url, html: `<html><body><main>${text}</main></body></html>` });
      }),
      sitemaps: vi.fn(async () => []),
    });
    const result = await crawlSite('https://example.com/', { fetcher });
    expect(result.pages.length).toBeLessThanOrEqual(MAX_EXTRA_PAGES + 1);
    expect(result.pages.length).toBe(MAX_EXTRA_PAGES + 1);
  });

  it('stops early once the top-terms vocabulary is stable across consecutive pages', async () => {
    const stableBody = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';
    const homeHtml = `<html><body><main>${stableBody}</main>${Array.from(
      { length: 8 },
      (_, i) => `<a href="https://example.com/page-${i}">p${i}</a>`,
    ).join('')}</body></html>`;
    const fetcher = asFetcher({
      fetchPage: vi.fn(async (url: string) => {
        if (url === 'https://example.com/') return page({ url, html: homeHtml });
        if (url === 'https://example.com/sitemap.xml') return null;
        return page({ url, html: `<html><body><main>${stableBody}</main></body></html>` });
      }),
      sitemaps: vi.fn(async () => []),
    });
    const result = await crawlSite('https://example.com/', { fetcher });
    // Home page + 3 stable extra pages, then it should stop well short of the 8 candidates.
    expect(result.pages.length).toBe(4);
  });

  it('collects an error message when the sitemap fetch itself throws', async () => {
    const fetcher = asFetcher({
      fetchPage: vi.fn(async (url: string) => {
        if (url === 'https://example.com/') {
          return page({ url, html: '<html><body>home</body></html>' });
        }
        throw new Error('sitemap unreachable');
      }),
      sitemaps: vi.fn(async () => []),
    });
    const result = await crawlSite('https://example.com/', { fetcher });
    expect(
      result.errors.some((e) => e.includes('sitemap') && e.includes('sitemap unreachable')),
    ).toBe(true);
  });

  it('collects a per-URL error message and continues crawling other candidates', async () => {
    const homeHtml = `<html><body>
      <a href="https://example.com/broken">broken</a>
      <a href="https://example.com/fine">fine</a>
    </body></html>`;
    const fetcher = asFetcher({
      fetchPage: vi.fn(async (url: string) => {
        if (url === 'https://example.com/') return page({ url, html: homeHtml });
        if (url === 'https://example.com/sitemap.xml') return null;
        if (url === 'https://example.com/broken') throw new Error('boom');
        return page({ url, html: '<html><body><main>fine content here</main></body></html>' });
      }),
      sitemaps: vi.fn(async () => []),
    });
    const result = await crawlSite('https://example.com/', { fetcher });
    expect(result.errors.some((e) => e.includes('broken') && e.includes('boom'))).toBe(true);
    expect(result.pages.map((p) => p.url)).toContain('https://example.com/fine');
  });
});

describe('createBrowserlessRenderer', () => {
  it('POSTs to {base}/content with the token as a Bearer header (never in the URL) and { url } as the body', async () => {
    const { fetch: fetchImpl, requests } = fakeFetch(
      new Response('<html><body>rendered</body></html>', { status: 200 }),
    );
    const renderer = createBrowserlessRenderer({
      token: 'tok123',
      fetchImpl,
      baseUrl: 'https://custom.browserless.example',
    });
    const html = await renderer.render('https://example.com/page');
    expect(html).toBe('<html><body>rendered</body></html>');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe('https://custom.browserless.example/content');
    expect(requests[0]?.headers.authorization).toBe('Bearer tok123');
    expect(requests[0]?.body).toEqual({ url: 'https://example.com/page' });
    expect(requests[0]?.headers['content-type']).toBe('application/json');
  });

  it('sends no Authorization header when the host has no token', async () => {
    const { fetch: fetchImpl, requests } = fakeFetch(new Response('<html></html>'));
    await createBrowserlessRenderer({ token: '', fetchImpl, baseUrl: 'http://h:3000' }).render(
      'https://example.com/',
    );
    expect(requests[0]?.url).toBe('http://h:3000/content');
    expect(requests[0]?.headers.authorization).toBeUndefined();
  });

  it('throws ValidationError when the render call is not ok', async () => {
    const { fetch: fetchImpl } = fakeFetch(new Response('nope', { status: 500 }));
    const renderer = createBrowserlessRenderer({ token: 'tok123', fetchImpl });
    await expect(renderer.render('https://example.com/page')).rejects.toThrow(ValidationError);
  });

  it('truncates the rendered HTML at 5 MB', async () => {
    const huge = 'x'.repeat(6 * 1024 * 1024);
    const { fetch: fetchImpl } = fakeFetch(new Response(huge, { status: 200 }));
    const renderer = createBrowserlessRenderer({ token: 'tok123', fetchImpl });
    const html = await renderer.render('https://example.com/page');
    expect(html).toHaveLength(5 * 1024 * 1024);
  });
});
