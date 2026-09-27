import { describe, expect, it, vi } from 'vitest';
import { fakeFetch } from '../../../../test/helpers/fake-fetch';
import { PoliteFetcher } from './fetch';

function robots(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
}

function makeFetcher(...replies: Parameters<typeof fakeFetch>) {
  const { fetch: fetchImpl, requests } = fakeFetch(...replies);
  const sleep = vi.fn(async (_ms: number) => undefined);
  const fetcher = new PoliteFetcher({ fetchImpl, sleep, now: () => 1_000, random: () => 0 });
  return { fetcher, requests, sleep };
}

describe('PoliteFetcher robots handling', () => {
  it('treats a 404 robots.txt as allow-all', async () => {
    const { fetcher } = makeFetcher(
      robots('not found', 404),
      new Response('<html><body>hi</body></html>', { status: 200 }),
    );
    const allowed = await fetcher.isAllowed('https://example.com/anything');
    expect(allowed).toBe(true);
    expect(await fetcher.sitemaps('https://example.com/')).toEqual([]);
  });

  it('treats a 500 robots.txt as disallow-all', async () => {
    const { fetcher } = makeFetcher(robots('boom', 500));
    expect(await fetcher.isAllowed('https://example.com/anything')).toBe(false);
  });

  it('treats an unreachable robots.txt (fetch throws) as disallow-all', async () => {
    const { fetcher } = makeFetcher(new Error('network down'));
    expect(await fetcher.isAllowed('https://example.com/anything')).toBe(false);
  });

  it('applies Disallow rules scoped to the PostMindStudio user-agent group', async () => {
    const body = [
      'User-agent: PostMindStudio',
      'Disallow: /private/',
      '',
      'User-agent: *',
      'Disallow: /admin/',
    ].join('\n');
    const { fetcher } = makeFetcher(robots(body));
    expect(await fetcher.isAllowed('https://example.com/private/x')).toBe(false);
    // Our UA has its own explicit group, so the generic "*" group does not apply to us.
    expect(await fetcher.isAllowed('https://example.com/admin/x')).toBe(true);
    expect(await fetcher.isAllowed('https://example.com/public/x')).toBe(true);
  });

  it('caps Crawl-delay for our user-agent at 10 seconds', async () => {
    const body = ['User-agent: PostMindStudio', 'Crawl-delay: 20'].join('\n');
    const { fetcher } = makeFetcher(robots(body));
    const rules = await fetcher.rulesFor(new URL('https://example.com/'));
    expect(rules.crawlDelayMs).toBe(10_000);
  });

  it('parses Sitemap directives', async () => {
    const body = [
      'Sitemap: https://example.com/sitemap1.xml',
      'Sitemap: https://example.com/sitemap2.xml',
    ].join('\n');
    const { fetcher } = makeFetcher(robots(body));
    expect(await fetcher.sitemaps('https://example.com/')).toEqual([
      'https://example.com/sitemap1.xml',
      'https://example.com/sitemap2.xml',
    ]);
  });
});

describe('PoliteFetcher per-host throttling', () => {
  it('waits at least 1s (plus jitter) between two requests to the same host', async () => {
    const { fetcher, sleep } = makeFetcher(
      robots('', 404),
      new Response('<html><body>one</body></html>', { status: 200 }),
      new Response('<html><body>two</body></html>', { status: 200 }),
    );
    await fetcher.fetchPage('https://example.com/one');
    await fetcher.fetchPage('https://example.com/two');
    // First call: robots.txt fetch (no prior request) then page fetch (waits the 1s minimum).
    // Second call: robots cached, page fetch waits the 1s minimum again.
    expect(sleep).toHaveBeenCalledWith(1_000);
    const oneSecondCalls = sleep.mock.calls.filter((call) => call[0] === 1_000);
    expect(oneSecondCalls).toHaveLength(2);
  });

  it('adds jitter from the injected random() on top of the 1s minimum', async () => {
    const { fetch: fetchImpl } = fakeFetch(
      robots('', 404),
      new Response('<html><body>one</body></html>', { status: 200 }),
    );
    const sleep = vi.fn(async (_ms: number) => undefined);
    const fetcher = new PoliteFetcher({ fetchImpl, sleep, now: () => 1_000, random: () => 0.5 });
    await fetcher.fetchPage('https://example.com/one');
    // robots.txt fetch: no previous request for the origin, so no sleep.
    // page fetch: interval = max(1000, 0) + floor(0.5 * 1000) = 1500.
    expect(sleep).toHaveBeenCalledWith(1_500);
  });

  it('honours a robots Crawl-delay as the throttling floor for subsequent page fetches', async () => {
    const body = ['User-agent: PostMindStudio', 'Crawl-delay: 20'].join('\n');
    const { fetch: fetchImpl } = fakeFetch(
      robots(body),
      new Response('<html><body>one</body></html>', { status: 200 }),
      new Response('<html><body>two</body></html>', { status: 200 }),
    );
    const sleep = vi.fn(async (_ms: number) => undefined);
    const fetcher = new PoliteFetcher({ fetchImpl, sleep, now: () => 1_000, random: () => 0 });
    await fetcher.fetchPage('https://example.com/one');
    await fetcher.fetchPage('https://example.com/two');
    // Crawl-delay is capped to 10s and used as the floor for the second page fetch.
    expect(sleep).toHaveBeenCalledWith(10_000);
  });
});

describe('PoliteFetcher without an injected random()', () => {
  it('falls back to Math.random() for jitter without throwing', async () => {
    const { fetch: fetchImpl } = fakeFetch(
      robots('', 404),
      new Response('<html><body>one</body></html>', { status: 200 }),
    );
    const sleep = vi.fn(async (_ms: number) => undefined);
    const fetcher = new PoliteFetcher({ fetchImpl, sleep, now: () => 1_000 });
    const page = await fetcher.fetchPage('https://example.com/one');
    expect(page).not.toBeNull();
  });
});

describe('PoliteFetcher.fetchPage', () => {
  it('returns null when robots disallows the URL', async () => {
    const body = ['User-agent: PostMindStudio', 'Disallow: /'].join('\n');
    const { fetcher } = makeFetcher(robots(body));
    expect(await fetcher.fetchPage('https://example.com/anything')).toBeNull();
  });

  it('returns the fetched page with metadata when allowed', async () => {
    const html = '<html><head><title>T</title></head><body>hi</body></html>';
    const { fetcher } = makeFetcher(
      robots('', 404),
      new Response(html, {
        status: 200,
        headers: {
          'content-type': 'text/html',
          etag: 'abc',
          'last-modified': 'yesterday',
        },
      }),
    );
    const page = await fetcher.fetchPage('https://example.com/');
    expect(page).not.toBeNull();
    expect(page?.status).toBe(200);
    expect(page?.contentType).toBe('text/html');
    expect(page?.html).toBe(html);
    expect(page?.etag).toBe('abc');
    expect(page?.lastModified).toBe('yesterday');
    expect(page?.truncated).toBe(false);
  });
});

describe('PoliteFetcher.download', () => {
  it('returns null when robots disallows the URL', async () => {
    const body = ['User-agent: PostMindStudio', 'Disallow: /images/'].join('\n');
    const { fetcher } = makeFetcher(robots(body));
    expect(await fetcher.download('https://example.com/images/a.jpg', 1_000_000)).toBeNull();
  });

  it('downloads the binary content when robots allows it', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { fetcher } = makeFetcher(
      robots('', 404),
      new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } }),
    );
    const res = await fetcher.download('https://example.com/a.png', 1_000_000);
    expect(res).not.toBeNull();
    expect(Array.from(res?.body ?? [])).toEqual([1, 2, 3, 4]);
  });
});
