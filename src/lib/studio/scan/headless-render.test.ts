import { describe, expect, it, vi } from 'vitest';
import { ConfigurationError, NotImplementedError, ValidationError } from '../../errors';
import { crawlSite, isBlockedStatus } from './crawl';
import type { FetchedPage, PoliteFetcher } from './fetch';
import {
  HEADLESS_NOT_CONFIGURED_MESSAGE,
  headlessRendererFromEnv,
  unconfiguredHeadlessRenderer,
  type HeadlessRenderer,
} from './headless-render';

// BACKLOG 13.37: browser-render fallback for blocked homepages, used only when configured.

const HOME = 'https://blocked.example/';

function fetcherReturning(home: Partial<FetchedPage>): PoliteFetcher {
  return {
    fetchPage: vi.fn(async (url: string) =>
      url === HOME
        ? {
            url: HOME,
            status: 200,
            contentType: 'text/html',
            html: '',
            etag: null,
            lastModified: null,
            truncated: false,
            ...home,
          }
        : null,
    ),
    sitemaps: vi.fn(async () => []),
  } as unknown as PoliteFetcher;
}

const renderedHtml =
  '<html><head><title>Leeds Sourdough</title></head><body><h1>Bakery</h1><p>Fresh bread daily in Leeds.</p></body></html>';

function headless(render: (url: string) => Promise<string>): HeadlessRenderer {
  return { configured: true, render: vi.fn(render) };
}

describe('headlessRendererFromEnv', () => {
  it('is unconfigured when STUDIO_HEADLESS_RENDER_URL is unset, and says so when called', async () => {
    const renderer = headlessRendererFromEnv({});
    expect(renderer).toBe(unconfiguredHeadlessRenderer);
    expect(renderer.configured).toBe(false);
    await expect(renderer.render(HOME)).rejects.toBeInstanceOf(NotImplementedError);
    await expect(renderer.render(HOME)).rejects.toThrow(HEADLESS_NOT_CONFIGURED_MESSAGE);
  });

  it('refuses a malformed or non-http URL', () => {
    expect(() => headlessRendererFromEnv({ STUDIO_HEADLESS_RENDER_URL: 'not a url' })).toThrow(
      ConfigurationError,
    );
    expect(() =>
      headlessRendererFromEnv({ STUDIO_HEADLESS_RENDER_URL: 'file:///etc/passwd' }),
    ).toThrow(ConfigurationError);
  });

  it('calls the self-hosted Browserless /content endpoint when configured', async () => {
    const fetchImpl = vi.fn(async () => new Response(renderedHtml, { status: 200 }));
    const renderer = headlessRendererFromEnv(
      {
        STUDIO_HEADLESS_RENDER_URL: 'http://headless.internal:3000/',
        STUDIO_HEADLESS_RENDER_TOKEN: 'tok',
      },
      fetchImpl as unknown as typeof fetch,
    );
    expect(renderer.configured).toBe(true);
    await expect(renderer.render(HOME)).resolves.toBe(renderedHtml);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://headless.internal:3000/content');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok');
    expect(JSON.parse(String(init.body))).toEqual({ url: HOME });
  });
});

describe('isBlockedStatus', () => {
  it('treats 403, 429 and 503 as bot-protection refusals only', () => {
    expect([403, 429, 503].every(isBlockedStatus)).toBe(true);
    expect([400, 401, 404, 410, 500].some(isBlockedStatus)).toBe(false);
  });
});

describe('crawlSite blocked-homepage fallback', () => {
  it('fails as before (manual entry) when no headless renderer is configured', async () => {
    const crawl = crawlSite(HOME, {
      fetcher: fetcherReturning({ status: 403 }),
      headless: unconfiguredHeadlessRenderer,
    });
    await expect(crawl).rejects.toBeInstanceOf(ValidationError);
    await expect(crawl).rejects.toThrow('HTTP 403');
  });

  it('renders a refused homepage through the headless host when configured', async () => {
    const renderer = headless(async () => renderedHtml);
    const result = await crawlSite(HOME, {
      fetcher: fetcherReturning({ status: 403 }),
      headless: renderer,
    });
    expect(renderer.render).toHaveBeenCalledWith(HOME);
    expect(result.usedJsRender).toBe(true);
    expect(result.pages[0]?.title).toBe('Leeds Sourdough');
  });

  it('does not render a homepage that is simply missing (404)', async () => {
    const renderer = headless(async () => renderedHtml);
    await expect(
      crawlSite(HOME, { fetcher: fetcherReturning({ status: 404 }), headless: renderer }),
    ).rejects.toThrow('HTTP 404');
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('keeps the original refusal, with the render failure in details, when the render fails', async () => {
    const renderer = headless(async () => {
      throw new ValidationError('Browserless render failed (HTTP 500)');
    });
    const err = await crawlSite(HOME, {
      fetcher: fetcherReturning({ status: 429 }),
      headless: renderer,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).message).toContain('HTTP 429');
    expect((err as ValidationError).details?.headlessRender).toContain('HTTP 500');
  });

  it('never renders when robots.txt disallows the homepage', async () => {
    const renderer = headless(async () => renderedHtml);
    const fetcher = {
      fetchPage: vi.fn(async () => null),
      sitemaps: vi.fn(async () => []),
    } as unknown as PoliteFetcher;
    const result = await crawlSite(HOME, { fetcher, headless: renderer });
    expect(result.robotsBlocked).toBe(true);
    expect(renderer.render).not.toHaveBeenCalled();
  });
});
