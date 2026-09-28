import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as profileRoute from '../../src/app/api/studio/businesses/[id]/business-profile/route';
import * as scanWebsiteRoute from '../../src/app/api/studio/businesses/[id]/scan-website/route';
import * as scansRoute from '../../src/app/api/studio/businesses/[id]/scans/route';
import * as imageRoute from '../../src/app/api/studio/image-library/[id]/route';
import * as generateRoute from '../../src/app/api/studio/image-library/generate/route';
import * as refreshRoute from '../../src/app/api/studio/image-library/refresh/route';
import * as libraryRoute from '../../src/app/api/studio/image-library/route';
import * as searchRoute from '../../src/app/api/studio/image-library/search/route';
import * as scanRoute from '../../src/app/api/studio/scans/[id]/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import type { StockImageSource } from '../../src/lib/studio/images/stock';
import { drainInline } from '../../src/lib/studio/queue/workers/runtime';
import { call, installApi, multipart, tenant } from '../helpers/api-harness';
import { createHarness } from '../helpers/pipeline-harness';
import { fakePng } from '../helpers/png';

// BACKLOG 6.1–6.7 end to end: scan a (fake) website through the real routes, the scan worker,
// the scripted Claude classifier and Postgres/pgvector; then list, search, generate, upload,
// delete and refresh the image library.

const hasDb = Boolean(process.env.DATABASE_URL);
const SITE = 'https://leeds-sourdough.example';

const html = (body: string, head = '') =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

const PAGES: Record<string, string> = {
  '/': html(
    `<main><h1>Leeds Sourdough Co</h1><p>${'Slow-fermented sourdough baked at dawn in Leeds. '.repeat(10)}</p>
     <img src="/img/hero.png" alt="Golden sourdough loaf">
     <img src="/icons/cart.png" alt="cart">
     <img src="/img/thumb.png" width="120" height="80">
     <a href="/about">About</a><a href="/products">Shop</a></main>`,
    '<title>Leeds Sourdough Co</title><meta name="description" content="Artisan sourdough delivered weekly">',
  ),
  '/about': html(
    `<main><h1>About us</h1><p>${'Family bakery since 2019. '.repeat(20)}</p><img src="/img/bakers.png" alt="Our bakers"></main>`,
  ),
  '/products': html(
    `<main><h1>Subscriptions</h1><p>${'Weekly sourdough subscription boxes. '.repeat(20)}</p></main>`,
  ),
};

const IMAGES: Record<string, Uint8Array<ArrayBuffer>> = {
  '/img/hero.png': fakePng(1600, 900, 1),
  '/img/bakers.png': fakePng(1200, 1200, 2),
  '/img/thumb.png': fakePng(120, 80, 3),
};

function site(robots = 'User-agent: *\nAllow: /\n'): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === 'images.stock.example') {
      const n = Number(url.pathname.replace(/\D/g, ''));
      return new Response(fakePng(2000, 1333, 100 + n), {
        headers: { 'content-type': 'image/png' },
      });
    }
    if (url.pathname === '/robots.txt') return new Response(robots);
    if (url.pathname === '/sitemap.xml') return new Response('not found', { status: 404 });
    const image = IMAGES[url.pathname];
    if (image) return new Response(image, { headers: { 'content-type': 'image/png' } });
    const page = PAGES[url.pathname];
    if (page) return new Response(page, { headers: { 'content-type': 'text/html' } });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

const stockSource: StockImageSource = {
  provider: 'pexels',
  async search({ query }) {
    const base = query.includes('bakery') ? 10 : 20;
    return [1, 2, 3].map((i) => ({
      provider: 'pexels' as const,
      providerImageId: String(base + i),
      imageUrl: `https://images.stock.example/${base + i}.png`,
      width: 2000,
      height: 1333,
      alt: `${query} photo ${i}`,
      pageUrl: `https://www.pexels.com/photo/${base + i}/`,
      attribution: { name: 'A Photographer', url: null },
      storable: true,
    }));
  },
  async downloadUrl(hit) {
    return hit.imageUrl;
  },
};

describe.skipIf(!hasDb)('website scan + image library API', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-scan-${randomUUID()}`;
  const otherOrg = `api-scan-other-${randomUUID()}`;
  const quotaOrg = `api-scan-quota-${randomUUID()}`;
  // 15.D2: scan-business limits (A10.3) and image generation (Plus+) are tier-gated and covered
  // in test/api/p15-d-tiers.test.ts; these suites exercise the mechanics on an Enterprise plan.
  const enterprise = (id: string) => ({
    ...tenant(id),
    organisation: { id, planTier: 'ENTERPRISE' },
  });
  const tokens = {
    owner: enterprise(org),
    reader: tenant(org, ['studio:project:read']),
    other: enterprise(otherOrg),
    quota: enterprise(quotaOrg),
  };
  let h: ReturnType<typeof createHarness>;

  const install = (pageFetch: typeof fetch) => {
    h = createHarness(db, { pageFetch, stockSources: [stockSource] });
    installApi(db, tokens, { queue: h.queue, publishing: h.deps.publishing, pipeline: h.deps });
  };

  beforeEach(() => install(site()));

  afterAll(async () => {
    setApiDeps(undefined);
    for (const organisationId of [org, otherOrg, quotaOrg]) {
      const businesses = (
        await db.websiteScan.findMany({ where: { organisationId }, select: { businessId: true } })
      ).map((s) => s.businessId);
      await db.imageLibraryQuery.deleteMany({ where: { businessId: { in: businesses } } });
      await db.imageLibraryItem.deleteMany({ where: { organisationId } });
      await db.businessProfile.deleteMany({ where: { organisationId } });
      await db.websiteScan.deleteMany({ where: { organisationId } });
      await db.providerJob.deleteMany({ where: { organisationId } });
    }
    await db.$disconnect();
  });

  // 15.D8 / A11.2: every scan request carries the checkbox text; tests that don't set one get it.
  const withStatement = (body: unknown) =>
    body && typeof body === 'object' && !('ownershipStatement' in body)
      ? {
          ...body,
          ownershipStatement: { locale: 'en-GB', messageKey: 'business.scan.ownershipStatement' },
        }
      : body;
  const scan = (businessId: string, body: unknown, token = 'owner') =>
    call(scanWebsiteRoute.POST, {
      method: 'POST',
      token,
      params: { id: businessId },
      body: withStatement(body),
    });

  it('scans a site, classifies it and builds the library from site + stock images', async () => {
    const biz = `biz-${randomUUID()}`;
    const started = await scan(biz, { url: `${SITE}/`, ownershipConfirmed: true });
    expect(started.status).toBe(202);
    const scanId = started.json.scanId as string;

    const drained = await drainInline(h.queue, h.deps);
    expect(drained.failedJobs).toEqual([]);

    const detail = await call(scanRoute.GET, { token: 'reader', params: { id: scanId } });
    const scanRow = detail.json.scan as Record<string, unknown>;
    expect(scanRow.state).toBe('SUCCEEDED');
    expect(scanRow.pagesCrawled).toBe(3);
    expect(scanRow.robotsBlocked).toBe(false);
    // hero + bakers (thumb is < 500px, the icon is filtered) + 6 stock (2 queries × 3)
    expect(scanRow.imagesIngested).toBe(8);
    expect(scanRow.library).toEqual({ SCRAPED: 2, STOCK: 6 });

    const classify = h.adapters.anthropic.requests.at(-1) as { prompt: string };
    expect(classify.prompt).toContain('<website_content>');
    expect(classify.prompt).toContain('Slow-fermented sourdough');

    const profile = await call(profileRoute.GET, { token: 'reader', params: { id: biz } });
    expect((profile.json.profile as Record<string, unknown>).subNiche).toBe(
      'artisan sourdough subscriptions',
    );

    const history = await call(scansRoute.GET, { token: 'reader', params: { id: biz } });
    expect((history.json.data as unknown[]).length).toBe(1);

    const scraped = await call(libraryRoute.GET, {
      token: 'reader',
      path: `/api/studio/image-library?businessId=${biz}&source=scraped`,
    });
    const items = scraped.json.data as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0]).not.toHaveProperty('s3Key');
    expect(String(items[0]?.previewUrl)).toContain('signed.example');

    const embedded = await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM studio.image_library
      WHERE "businessId" = ${biz} AND embedding IS NOT NULL`;
    expect(Number(embedded[0]?.n)).toBe(8);

    const search = await call(searchRoute.POST, {
      method: 'POST',
      token: 'reader',
      body: { businessId: biz, query: 'golden sourdough loaf', limit: 3 },
    });
    const hits = search.json.data as Array<{ altText: string; similarity: number }>;
    expect(hits[0]?.altText).toBe('Golden sourdough loaf');
    expect(hits[0]?.similarity).toBeGreaterThan(hits[2]?.similarity ?? 1);

    // A second scan of the same business while one runs is refused; after it finishes it's fine.
    const again = await scan(biz, { url: SITE, ownershipConfirmed: true });
    expect(again.status).toBe(202);
    expect((await scan(biz, { url: SITE, ownershipConfirmed: true })).status).toBe(409);
  });

  it('keeps user edits to the profile across re-scans', async () => {
    const biz = `biz-${randomUUID()}`;
    await scan(biz, { url: SITE, ownershipConfirmed: true });
    await drainInline(h.queue, h.deps);

    const patched = await call(profileRoute.PATCH, {
      method: 'PATCH',
      token: 'owner',
      params: { id: biz },
      body: { subNiche: 'rye and sourdough', imageSearchQueries: ['rye bread'] },
    });
    expect(patched.status).toBe(200);
    expect((patched.json.profile as Record<string, unknown>).editedByUser).toBe(true);
    expect(
      (
        await call(profileRoute.PATCH, {
          method: 'PATCH',
          token: 'owner',
          params: { id: biz },
          body: { bogus: 1 },
        })
      ).status,
    ).toBe(400);

    await scan(biz, { url: SITE, ownershipConfirmed: true });
    await drainInline(h.queue, h.deps);
    const profile = await db.businessProfile.findUniqueOrThrow({
      where: { organisationId_businessId: { organisationId: org, businessId: biz } },
    });
    expect(profile.subNiche).toBe('rye and sourdough');
    expect(profile.imageSearchQueries).toEqual(['rye bread']);
  });

  it('fails cleanly when robots.txt disallows the site', async () => {
    install(site('User-agent: PostMindStudio\nDisallow: /\n'));
    const biz = `biz-${randomUUID()}`;
    const started = await scan(biz, { url: SITE, ownershipConfirmed: true });
    await drainInline(h.queue, h.deps);
    const row = await db.websiteScan.findUniqueOrThrow({
      where: { id: started.json.scanId as string },
    });
    expect(row.state).toBe('FAILED');
    expect(row.robotsBlocked).toBe(true);
    expect(row.errorReason).toContain('robots.txt');
  });

  it('validates scan requests and isolates business ids per organisation', async () => {
    const biz = `biz-${randomUUID()}`;
    expect((await scan(biz, { url: SITE })).status).toBe(400);
    expect((await scan(biz, { url: SITE, ownershipConfirmed: false })).status).toBe(400);
    expect(
      (await scan(biz, { url: 'http://127.0.0.1/admin', ownershipConfirmed: true })).status,
    ).toBe(400);
    expect((await scan(biz, { url: 'ftp://example.com', ownershipConfirmed: true })).status).toBe(
      400,
    );
    expect((await scan(biz, { url: SITE, ownershipConfirmed: true }, 'reader')).status).toBe(403);

    expect((await scan(biz, { url: SITE, ownershipConfirmed: true })).status).toBe(202);
    // Another organisation using the same business id gets its own, independent scan.
    expect((await scan(biz, { url: SITE, ownershipConfirmed: true }, 'other')).status).toBe(202);
    await drainInline(h.queue, h.deps);
    expect(await db.businessProfile.count({ where: { businessId: biz } })).toBe(2);
    expect(
      (await call(profileRoute.GET, { token: 'other', params: { id: biz } })).json.profile,
    ).toMatchObject({ organisationId: otherOrg });
  });

  it('caps concurrent scans per organisation across business ids', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await scan(
        `biz-q${i}-${randomUUID()}`,
        { url: SITE, ownershipConfirmed: true },
        'quota',
      );
      expect(res.status).toBe(202);
    }
    const fourth = await scan(
      `biz-q3-${randomUUID()}`,
      { url: SITE, ownershipConfirmed: true },
      'quota',
    );
    expect(fourth.status).toBe(429);
    await drainInline(h.queue, h.deps);
    expect(
      (await scan(`biz-q4-${randomUUID()}`, { url: SITE, ownershipConfirmed: true }, 'quota'))
        .status,
    ).toBe(202);
  });

  it('generates, uploads, reads, deletes and refreshes library images', async () => {
    const biz = `biz-${randomUUID()}`;
    const generated = await call(generateRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: { businessId: biz, prompt: 'A rustic loaf on a linen cloth', aspectRatio: '1:1' },
    });
    expect(generated.status).toBe(201);
    const image = generated.json.image as Record<string, unknown>;
    expect(image.source).toBe('GENERATED');
    expect(image.widthPx).toBe(1024);

    const form = new FormData();
    form.set('businessId', biz);
    form.set('tags', 'Crust, crumb');
    form.set('file', new Blob([fakePng(900, 1200, 77)], { type: 'image/png' }), 'loaf.png');
    const uploaded = await call(libraryRoute.POST, {
      method: 'POST',
      token: 'owner',
      ...(await multipart(form)),
    });
    expect(uploaded.status).toBe(201);
    const up = uploaded.json.image as Record<string, unknown>;
    expect(up.source).toBe('UPLOAD');
    expect(up.tags).toEqual(['crust', 'crumb']);

    const tooSmall = new FormData();
    tooSmall.set('businessId', biz);
    tooSmall.set('file', new Blob([fakePng(100, 100, 5)]), 'tiny.png');
    const tiny = await call(libraryRoute.POST, {
      method: 'POST',
      token: 'owner',
      ...(await multipart(tooSmall)),
    });
    expect(tiny.status).toBe(400);

    const id = String(up.id);
    expect((await call(imageRoute.GET, { token: 'other', params: { id } })).status).toBe(404);
    expect((await call(imageRoute.GET, { token: 'reader', params: { id } })).status).toBe(200);
    const deleted = await call(imageRoute.DELETE, {
      method: 'DELETE',
      token: 'owner',
      params: { id },
    });
    expect(deleted.status).toBe(200);
    expect((await call(imageRoute.GET, { token: 'reader', params: { id } })).status).toBe(404);

    expect(
      (await call(refreshRoute.POST, { method: 'POST', token: 'owner', body: { businessId: biz } }))
        .status,
    ).toBe(400);
    const refreshed = await call(refreshRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: { businessId: biz, queries: ['artisan bakery'] },
    });
    expect(refreshed.status).toBe(202);
    await drainInline(h.queue, h.deps);
    expect(await db.imageLibraryItem.count({ where: { businessId: biz, source: 'STOCK' } })).toBe(
      3,
    );
  });
});
