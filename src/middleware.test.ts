import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, middleware } from './middleware';

// BACKLOG 20.7 — Shotstack and the workers fetch render fonts from APP_URL/fonts/<Family>.ttf
// without a session: the page guard must never match or redirect them, and must still match the
// app's pages. Matching uses Next's own matcher logic (next/experimental/testing/server).

const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url, nextConfig: {} });

afterEach(() => vi.unstubAllEnvs());

describe('middleware and /fonts', () => {
  it('does not run for font files (paths with an extension are excluded)', () => {
    for (const url of ['/fonts/NotoSans.ttf', '/fonts/NotoSansSC.ttf', '/fonts/Montserrat.ttf'])
      expect(matches(url), url).toBe(false);
  });

  it('runs for app pages and not for API routes, Next internals or share links', () => {
    for (const url of ['/', '/projects', '/settings/members', '/fonts'])
      expect(matches(url), url).toBe(true);
    for (const url of ['/api/health', '/_next/static/chunk.js', '/p/token', '/favicon.ico'])
      expect(matches(url), url).toBe(false);
  });

  it('lets a signed-out request for a font through even if it ran', () => {
    vi.stubEnv('STUDIO_MODE', 'standalone');
    const res = middleware(new NextRequest('https://studio.example.com/fonts/Montserrat.ttf'));
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('redirects a signed-out app page to sign-in', () => {
    vi.stubEnv('STUDIO_MODE', 'standalone');
    const res = middleware(new NextRequest('https://studio.example.com/projects'));
    expect(res.headers.get('location')).toContain('/sign-in?next=%2Fprojects');
  });
});
