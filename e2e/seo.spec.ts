import { expect, test } from '@playwright/test';

// /robots.txt and /sitemap.xml were 404 on production (full QA 2026-10-03). They are public (the
// page guard never matches a path with a file extension) and need no database.

test('robots.txt keeps crawlers out of the API and the signed-in app and names the sitemap', async ({
  request,
}) => {
  const res = await request.get('/robots.txt');
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toMatch(/User-Agent: \*/i);
  expect(body).toContain('Disallow: /api/');
  expect(body).toContain('Disallow: /projects');
  expect(body).toContain('Disallow: /settings');
  expect(body).toMatch(/Sitemap: https?:\/\/[^\s]+\/sitemap\.xml/);
});

test('sitemap.xml lists the marketing and legal pages and nothing signed-in', async ({
  request,
}) => {
  const res = await request.get('/sitemap.xml');
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toContain('/pricing</loc>');
  for (const doc of ['terms', 'privacy', 'cookies', 'acceptable-use', 'dpa', 'subprocessors'])
    expect(body).toContain(`/legal/${doc}</loc>`);
  expect(body).not.toContain('/projects');
  expect(body).not.toContain('/api/');
});
