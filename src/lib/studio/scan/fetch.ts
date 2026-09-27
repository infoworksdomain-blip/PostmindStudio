import robotsParser from 'robots-parser';
import { safeGet, type SafeResponse } from './safe-fetch';

// BACKLOG 6.1 / Addendum A6.2 + A6.7 — polite page fetching for website scans:
//  - User-Agent 'PostMindStudio/1.0 (+https://studio.postmind.ai/bot)';
//  - robots.txt respected on every fetch (RFC 9309: 4xx → no rules; 5xx/unreachable → full
//    disallow, so a scan fails cleanly rather than crawling a site whose rules we could not read);
//  - 1 request/second per host plus 0–1s random jitter, never parallel to the same host;
//  - 30s timeout per request; HTML capped at 5 MB.

export const SCAN_USER_AGENT = 'PostMindStudio/1.0 (+https://studio.postmind.ai/bot)';
export const ROBOTS_AGENT_TOKEN = 'PostMindStudio';
export const PAGE_TIMEOUT_MS = 30_000;
export const MAX_HTML_BYTES = 5 * 1024 * 1024;
export const MIN_INTERVAL_MS = 1_000;

export interface PoliteFetcherDeps {
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random?: () => number;
}

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  html: string;
  etag: string | null;
  lastModified: string | null;
  truncated: boolean;
}

export interface ConditionalCheck {
  status: number;
  unchanged: boolean;
  etag: string | null;
  lastModified: string | null;
}

/**
 * Unchanged when the server answers 304 Not Modified (RFC 9110 §15.4.5), or a 200 carries the
 * same strong ETag or the same Last-Modified as before. With no validators to compare, the page
 * counts as changed (a rescan runs).
 */
export function unchangedFrom(
  status: number,
  headers: Headers,
  previous: { etag: string | null; lastModified: string | null },
): ConditionalCheck {
  const etag = headers.get('etag');
  const lastModified = headers.get('last-modified');
  const sameEtag =
    previous.etag !== null && etag !== null && !etag.startsWith('W/') && etag === previous.etag;
  const sameDate =
    previous.lastModified !== null &&
    lastModified !== null &&
    lastModified === previous.lastModified;
  const hadValidators = previous.etag !== null || previous.lastModified !== null;
  const unchanged =
    (status === 304 && hadValidators) || (status >= 200 && status < 300 && (sameEtag || sameDate));
  return {
    status,
    unchanged,
    etag: etag ?? previous.etag,
    lastModified: lastModified ?? previous.lastModified,
  };
}

interface RobotsRules {
  isAllowed(url: string): boolean;
  sitemaps: string[];
  crawlDelayMs: number;
}

const ALLOW_ALL: RobotsRules = { isAllowed: () => true, sitemaps: [], crawlDelayMs: 0 };
const DISALLOW_ALL: RobotsRules = { isAllowed: () => false, sitemaps: [], crawlDelayMs: 0 };
const MAX_CRAWL_DELAY_MS = 10_000;

export class PoliteFetcher {
  private readonly robots = new Map<string, Promise<RobotsRules>>();
  private readonly lastRequestAt = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  requests = 0;

  constructor(private readonly deps: PoliteFetcherDeps) {}

  /** Robots rules for the URL's origin (fetched once per origin, itself rate-limited). */
  rulesFor(url: URL): Promise<RobotsRules> {
    const origin = url.origin;
    let rules = this.robots.get(origin);
    if (!rules) {
      rules = this.loadRobots(origin);
      this.robots.set(origin, rules);
    }
    return rules;
  }

  async isAllowed(rawUrl: string): Promise<boolean> {
    const url = new URL(rawUrl);
    return (await this.rulesFor(url)).isAllowed(url.toString());
  }

  async sitemaps(rawUrl: string): Promise<string[]> {
    return (await this.rulesFor(new URL(rawUrl))).sitemaps;
  }

  private async loadRobots(origin: string): Promise<RobotsRules> {
    const robotsUrl = `${origin}/robots.txt`;
    let res: SafeResponse;
    try {
      res = await this.throttled(origin, 0, () =>
        safeGet(robotsUrl, {
          fetchImpl: this.deps.fetchImpl,
          userAgent: SCAN_USER_AGENT,
          timeoutMs: PAGE_TIMEOUT_MS,
          maxBytes: 512 * 1024,
          accept: 'text/plain',
        }),
      );
    } catch {
      return DISALLOW_ALL;
    }
    if (res.status >= 500) return DISALLOW_ALL;
    if (res.status >= 400) return ALLOW_ALL;
    const robot = robotsParser(robotsUrl, new TextDecoder().decode(res.body));
    const delaySec = robot.getCrawlDelay(ROBOTS_AGENT_TOKEN);
    return {
      isAllowed: (url) => robot.isAllowed(url, ROBOTS_AGENT_TOKEN) !== false,
      sitemaps: robot.getSitemaps(),
      crawlDelayMs: Math.min(MAX_CRAWL_DELAY_MS, Math.max(0, (delaySec ?? 0) * 1000)),
    };
  }

  /** Serialises requests and spaces them ≥1s (plus jitter, plus any robots Crawl-delay) per host. */
  private throttled<T>(origin: string, extraDelayMs: number, run: () => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      const last = this.lastRequestAt.get(origin);
      const jitter = Math.floor((this.deps.random ?? Math.random)() * 1000);
      const interval = Math.max(MIN_INTERVAL_MS, extraDelayMs) + jitter;
      if (last !== undefined) {
        const wait = last + interval - this.deps.now();
        if (wait > 0) await this.deps.sleep(wait);
      }
      this.lastRequestAt.set(origin, this.deps.now());
      this.requests += 1;
      return run();
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  /** Download binary content (e.g. a scraped image) under the same robots + rate rules. */
  async download(
    rawUrl: string,
    maxBytes: number,
    accept = 'image/*',
  ): Promise<SafeResponse | null> {
    const url = new URL(rawUrl);
    const rules = await this.rulesFor(url);
    if (!rules.isAllowed(url.toString())) return null;
    return this.throttled(url.origin, rules.crawlDelayMs, () =>
      safeGet(url.toString(), {
        fetchImpl: this.deps.fetchImpl,
        userAgent: SCAN_USER_AGENT,
        timeoutMs: PAGE_TIMEOUT_MS,
        maxBytes,
        accept,
      }),
    );
  }

  /**
   * A6.6 skip-if-unchanged: a conditional GET of a page (If-None-Match / If-Modified-Since),
   * under the same robots, rate-limit and SSRF rules. Only the headers matter, so at most a few
   * bytes of the body are read. null when robots disallows the page.
   */
  async checkUnchanged(
    rawUrl: string,
    validators: { etag: string | null; lastModified: string | null },
  ): Promise<ConditionalCheck | null> {
    const url = new URL(rawUrl);
    const rules = await this.rulesFor(url);
    if (!rules.isAllowed(url.toString())) return null;
    const res = await this.throttled(url.origin, rules.crawlDelayMs, () =>
      safeGet(url.toString(), {
        fetchImpl: this.deps.fetchImpl,
        userAgent: SCAN_USER_AGENT,
        timeoutMs: PAGE_TIMEOUT_MS,
        maxBytes: 1,
        accept: 'text/html,application/xhtml+xml',
        conditional: {
          ifNoneMatch: validators.etag ?? undefined,
          ifModifiedSince: validators.lastModified ?? undefined,
        },
      }),
    );
    return unchangedFrom(res.status, res.headers, validators);
  }

  /** Fetch one page if robots allows it; null when disallowed. */
  async fetchPage(
    rawUrl: string,
    accept = 'text/html,application/xhtml+xml',
  ): Promise<FetchedPage | null> {
    const url = new URL(rawUrl);
    const rules = await this.rulesFor(url);
    if (!rules.isAllowed(url.toString())) return null;
    const res = await this.throttled(url.origin, rules.crawlDelayMs, () =>
      safeGet(url.toString(), {
        fetchImpl: this.deps.fetchImpl,
        userAgent: SCAN_USER_AGENT,
        timeoutMs: PAGE_TIMEOUT_MS,
        maxBytes: MAX_HTML_BYTES,
        accept,
      }),
    );
    return {
      url: res.url,
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      html: new TextDecoder().decode(res.body),
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
      truncated: res.truncated,
    };
  }
}
