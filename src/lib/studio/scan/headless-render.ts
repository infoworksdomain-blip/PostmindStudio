import { ConfigurationError, NotImplementedError } from '../../errors';
import { createBrowserlessRenderer, type PageRenderer } from './crawl';

// BACKLOG 13.37 — browser-render fallback for website scans whose homepage fetch is refused
// (HTTP 403 / 429 / 503 from bot protection). The playbook names a Playwright fallback; Studio
// runs no browser itself, so the renderer is a self-hosted headless Chromium host the operator
// deploys. The supported host is the open-source Browserless image (ghcr.io/browserless/chromium),
// whose REST API includes POST /content (render a URL, return the HTML):
//   https://docs.browserless.io/enterprise/open-source   (self-hosted image; /content included)
//   https://docs.browserless.io/rest-apis/content        (request/response)
//
// STUDIO_HEADLESS_RENDER_URL = the host's base URL (e.g. http://headless.internal:3000);
// STUDIO_HEADLESS_RENDER_TOKEN = its TOKEN, when the host sets one. Unset URL = not configured:
// the scanner never calls it and a blocked scan fails as today (manual entry + stock images).
//
// Guard rails (runbooks/scan-blocked.md): robots.txt is still read with Studio's SSRF-guarded
// fetcher first and a disallow stops the scan; only the homepage URL the guarded fetcher already
// reached is rendered; no CAPTCHA solving, no proxy rotation.

export interface HeadlessRenderer extends PageRenderer {
  readonly configured: boolean;
}

export const HEADLESS_NOT_CONFIGURED_MESSAGE =
  'Browser-render fallback is not configured: set STUDIO_HEADLESS_RENDER_URL to a headless Chromium host';

export const unconfiguredHeadlessRenderer: HeadlessRenderer = {
  configured: false,
  async render() {
    throw new NotImplementedError(HEADLESS_NOT_CONFIGURED_MESSAGE);
  },
};

export function headlessRendererFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = globalThis.fetch,
): HeadlessRenderer {
  const raw = env.STUDIO_HEADLESS_RENDER_URL?.trim();
  if (!raw) return unconfiguredHeadlessRenderer;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError('STUDIO_HEADLESS_RENDER_URL is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigurationError('STUDIO_HEADLESS_RENDER_URL must be http(s)');
  }
  const renderer = createBrowserlessRenderer({
    token: env.STUDIO_HEADLESS_RENDER_TOKEN?.trim() ?? '',
    fetchImpl,
    baseUrl: url.toString().replace(/\/+$/, ''),
  });
  return { configured: true, render: (pageUrl) => renderer.render(pageUrl) };
}
