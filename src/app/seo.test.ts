import { describe, expect, it } from 'vitest';
import robots, { dynamic as robotsDynamic } from './robots';
import sitemap, { dynamic as sitemapDynamic } from './sitemap';
import { isProtectedPage, PROTECTED_PAGE_PREFIXES } from '@/lib/auth/page-guard';
import { LEGAL_DOCS } from '@/lib/legal/documents';
import { siteOrigin } from '@/lib/seo/site';

describe('robots.txt', () => {
  it('disallows the API and every signed-in area, allows the rest, and points at the sitemap', () => {
    const r = robots();
    const rule = Array.isArray(r.rules) ? r.rules[0]! : r.rules;
    const disallow = ([] as string[]).concat(rule.disallow ?? []);
    expect(rule.allow).toBe('/');
    expect(disallow).toContain('/api/');
    for (const p of ['/projects', '/settings', '/admin', '/new', '/p/']) {
      expect(disallow).toContain(p);
    }
    expect(disallow).not.toContain('/');
    expect(disallow).not.toContain('/pricing');
    expect(r.sitemap).toMatch(/\/sitemap\.xml$/);
  });

  it('lists each private section once (robots rules are prefix matches)', () => {
    const r = robots();
    const rule = Array.isArray(r.rules) ? r.rules[0]! : r.rules;
    const disallow = ([] as string[]).concat(rule.disallow ?? []);
    expect(new Set(disallow).size).toBe(disallow.length);
    for (const p of disallow) {
      if (p.endsWith('/')) expect(disallow).not.toContain(p.slice(0, -1));
    }
    for (const p of PROTECTED_PAGE_PREFIXES) expect(disallow).toContain(p);
  });

  it('never lists a protected page as crawlable in the sitemap', () => {
    for (const entry of sitemap()) {
      expect(isProtectedPage(new URL(entry.url).pathname)).toBe(false);
    }
  });
});

describe('sitemap.xml', () => {
  it('covers home, pricing, sign-in, sign-up and all six legal documents with absolute URLs', () => {
    const urls = sitemap().map((e) => e.url);
    const origin = siteOrigin();
    expect(urls).toContain(origin);
    for (const p of ['/pricing', '/sign-in', '/sign-up']) expect(urls).toContain(`${origin}${p}`);
    for (const doc of LEGAL_DOCS) expect(urls).toContain(`${origin}/legal/${doc}`);
    expect(urls).toHaveLength(4 + LEGAL_DOCS.length);
  });

  it('dates every entry (lastmod) with a valid date', () => {
    for (const entry of sitemap()) {
      expect(Number.isNaN(new Date(String(entry.lastModified)).getTime()), entry.url).toBe(false);
    }
  });

  it('leaves out utility pages that are noindex', () => {
    const paths = sitemap().map((e) => new URL(e.url).pathname);
    for (const p of ['/forgot-password', '/reset-password', '/verify-email', '/two-factor']) {
      expect(paths).not.toContain(p);
    }
  });
});

describe('runtime origin', () => {
  it('renders robots and sitemap per request so the runtime APP_URL is used, not localhost', () => {
    expect(robotsDynamic).toBe('force-dynamic');
    expect(sitemapDynamic).toBe('force-dynamic');
  });
});

describe('siteOrigin', () => {
  it('uses APP_URL without a trailing slash or path', () => {
    expect(siteOrigin({ APP_URL: 'https://studio.example.com/' })).toBe(
      'https://studio.example.com',
    );
  });
  it('falls back to localhost when unset or invalid', () => {
    expect(siteOrigin({})).toBe('http://localhost:3000');
    expect(siteOrigin({ APP_URL: 'not a url' })).toBe('http://localhost:3000');
  });
});
