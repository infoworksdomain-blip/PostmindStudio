import { enableTwoFactor } from './pass2.support';
import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page, type Response } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { chooseLanguage, chooseTheme } from './shell.support';

// QA agent 4: the reference library (/library, /library/[id], "Picked for your business",
// similar videos, licence rules, the staff Library tab) and templates (/templates, the template
// picker on Create). Prisma fixtures, real UI. The embedding API is replaced by
// e2e/qa/embedding-stub.cjs (start the app with QA_EMBEDDING_STUB=1 NODE_OPTIONS="--require
// ./e2e/qa/embedding-stub.cjs" OPENAI_API_KEY=stub); thumbnails and previews are fulfilled here.
// Inventory: e2e/qa/library-templates.inventory.md.

// The stub is a CommonJS preload (NODE_OPTIONS --require), so it is loaded the same way here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { embed } = require('./embedding-stub.cjs') as {
  embed: (text: string) => number[];
};

const hasDb = Boolean(process.env.DATABASE_URL);
const run = randomUUID().slice(0, 8);
const password = `Qa4-${randomUUID()}`;
const ownerEmail = `qa4-owner-${run}@example.test`;
const staffEmail = `qa4-staff-${run}@example.test`;
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const ERROR_TEXT = [
  /Couldn[’']t load this/,
  /Something went wrong/,
  /That didn[’']t go through/,
  /We couldn[’']t finish that on our side/,
  /You don[’']t have permission/,
  /Application error/,
  /Internal Server Error/,
];

interface Issue {
  page: string;
  kind: string;
  detail: string;
}

/** 4xx answers that are normal here: a missing profile / reference answers 404 on purpose. */
const EXPECTED_4XX: Array<{ url: RegExp; status: number[] }> = [
  { url: /\/api\/studio\/me\b/, status: [401, 403] },
  { url: /\/api\/auth\/get-session/, status: [401] },
  { url: /\/api\/studio\/library\/recommended/, status: [404] },
  { url: /\/api\/studio\/library\/(videos|blueprint)\/[^/]+/, status: [404] },
];

class Watcher {
  readonly issues: Issue[] = [];
  current = '';
  /** Pages that deliberately provoke errors turn the collector off. */
  paused = false;
  /** Before the Admin Centre: staff without an organisation get 403 on every workspace call. */
  noOrganisation = false;

  constructor(private readonly page: Page) {
    page.on('pageerror', (e) => this.add('pageerror', e.message));
    page.on('console', (msg) => {
      if (msg.type() !== 'error' || /Failed to load resource/.test(msg.text())) return;
      this.add('console', msg.text().slice(0, 300));
    });
    page.on('response', (res) => void this.onResponse(res));
  }

  private add(kind: string, detail: string): void {
    if (!this.paused) this.issues.push({ page: this.current, kind, detail });
  }

  private async onResponse(res: Response): Promise<void> {
    const url = res.url();
    const status = res.status();
    if (!url.includes('/api/') || status < 400) return;
    if (status < 500 && EXPECTED_4XX.some((e) => e.url.test(url) && e.status.includes(status))) {
      return;
    }
    if (status === 403 && this.noOrganisation) return;
    if (status === 403) {
      // Staff without an organisation: the shell's workspace calls answer 403 no_organisation by
      // design (the Admin Centre must not depend on them).
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (body.error === 'no_organisation') return;
    }
    this.add('http', `${res.request().method()} ${new URL(url).pathname} → ${status}`);
  }

  async visit(path: string): Promise<void> {
    this.current = path;
    await this.page.goto(path);
    await this.settle();
    await this.check();
  }

  async settle(): Promise<void> {
    await this.page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  }

  async check(): Promise<void> {
    const body = (
      await this.page
        .locator('body')
        .innerText()
        .catch(() => '')
    ).trim();
    if (!body) this.add('blank', 'empty body');
    for (const re of ERROR_TEXT) if (re.test(body)) this.add('banner', String(re));
  }

  expectClean(): void {
    expect(this.issues).toEqual([]);
  }
}

test.skip(!hasDb, 'DATABASE_URL is not set: the library QA needs the app’s database');
test.describe.configure({ mode: 'serial', timeout: 300_000 });

let db: PrismaClient;
let orgId = '';
let businessId = '';
const ids: Record<string, string> = {};
const fillerTitles: string[] = [];
const titles = {
  bakery: `Sourdough bakery morning ${run}`,
  gym: `Gym motivation ${run}`,
  scraped: `Street food scraped ${run}`,
  expired: `Expired licence reel ${run}`,
  unlicensed: `No licence reel ${run}`,
  retired: `Retired reel ${run}`,
};

async function signUp(page: Page, email: string, name: string): Promise<void> {
  await page.goto('/sign-up');
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /sign up|create account/i }).click();
  await expect
    .poll(
      async () =>
        (await db.user.updateMany({ where: { email }, data: { emailVerified: true } })).count,
      { timeout: 120_000 },
    )
    .toBe(1);
}

async function signIn(page: Page, as: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel(/email/i).fill(as);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 180_000 }),
    page.getByRole('button', { name: /sign in/i }).click(),
  ]);
}

let ipCounter = 0;
let ownerCookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];

/**
 * Better Auth rate-limits sign-in per client IP (x-real-ip when no proxy is trusted) and every
 * spec runs from 127.0.0.1, so each test claims its own address instead of sharing a bucket with
 * the other specs (sign-in 5/min per IP, 10/h per email).
 */
function uniqueIp(): string {
  ipCounter += 1;
  const base = Number.parseInt(run.slice(0, 4), 16) % 100;
  return `10.${100 + base}.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'x-real-ip': uniqueIp() });
});

/** Reuse the owner's session from the fixtures test instead of signing in again. */
async function useOwnerSession(page: Page): Promise<void> {
  await page.context().addCookies(ownerCookies);
}

/** Library thumbnails and previews are signed S3 URLs: nothing is fetched, answer locally. */
async function stubStorage(page: Page): Promise<void> {
  await page.route(/ci-library\.s3|\.amazonaws\.com/, (route) =>
    route.request().resourceType() === 'image'
      ? route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL })
      : route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.alloc(0) }),
  );
}

async function useBusiness(page: Page, id: string | null): Promise<void> {
  await page.addInitScript((value) => {
    if (value) window.localStorage.setItem('studio.businessId', value);
    else window.localStorage.removeItem('studio.businessId');
  }, id);
}

async function insertEmbedding(itemId: string, text: string): Promise<void> {
  const literal = `[${embed(text).join(',')}]`;
  await db.$executeRawUnsafe(
    `INSERT INTO studio.video_library_embeddings (id, "libraryItemId", embedding, "embeddingModel")
     VALUES ($1, $2, $3::vector, 'qa-stub')`,
    randomUUID(),
    itemId,
    literal,
  );
}

interface SeedItem {
  key: string;
  title: string;
  tags: string[];
  durationSec: number;
  mood: string;
  scenario?: 'OWNED' | 'LICENSED' | 'SCRAPED';
  expires?: Date;
  noLicence?: boolean;
  retired?: boolean;
}

async function seedItem(categoryId: string, item: SeedItem): Promise<string> {
  const row = await db.videoLibraryItem.create({
    data: {
      title: item.title,
      description: `QA reference ${item.key}`,
      categoryId,
      tags: item.tags,
      s3Bucket: 'ci-library',
      s3Key: `qa4/${run}/${item.key}.mp4`,
      thumbnailS3Key: `qa4/${run}/${item.key}.jpg`,
      durationSec: item.durationSec,
      aspectRatio: '9:16',
      retiredAt: item.retired ? new Date() : null,
      ...(item.noLicence
        ? {}
        : {
            license: {
              create: {
                scenario: item.scenario ?? 'OWNED',
                licenseExpires: item.expires ?? null,
                allowedModes: item.scenario === 'SCRAPED' ? ['INSPIRE'] : ['TEMPLATE', 'INSPIRE'],
              },
            },
          }),
      analysis: {
        create: {
          shotCount: 2,
          shots: [
            { startSec: 0, endSec: 9, type: 'HOOK_TEXT_ON_STILL', overlayStyle: 'bold-centre' },
            { startSec: 9, endSec: item.durationSec, type: 'PRODUCT_SHOT', voiceoverPresent: true },
          ],
          transcript: { words: [] },
          overlayTimeline: [],
          musicEnvelope: { bpm: 96, energy: 'medium', mood: item.mood, genre: 'acoustic' },
          hookPattern: 'question',
          structurePattern: 'hook-demo-cta',
          ctaPattern: 'visit',
          paceTag: 'medium',
          moodTag: item.mood,
        },
      },
    },
  });
  await insertEmbedding(row.id, `${item.title} ${item.tags.join(' ')}`);
  return row.id;
}

test.beforeAll(async () => {
  db = new PrismaClient();
});

test.afterAll(async () => {
  const items = await db.videoLibraryItem.findMany({
    where: { s3Key: { startsWith: `qa4/${run}/` } },
    select: { id: true },
  });
  const itemIds = items.map((i) => i.id);
  await db.videoLibraryEmbedding.deleteMany({ where: { libraryItemId: { in: itemIds } } });
  await db.videoLibraryAnalysis.deleteMany({ where: { libraryItemId: { in: itemIds } } });
  await db.videoLibraryLicense.deleteMany({ where: { libraryItemId: { in: itemIds } } });
  await db.videoLibraryItem.deleteMany({ where: { id: { in: itemIds } } });
  await db?.$disconnect();
});

test('fixtures: an owner with an organisation, a business profile and a reference corpus', async ({
  page,
}) => {
  test.setTimeout(600_000);
  await signUp(page, ownerEmail, 'QA Owner');
  const user = await db.user.findFirstOrThrow({ where: { email: ownerEmail } });
  orgId = `qa4-org-${run}`;
  await db.organization.create({
    data: { id: orgId, name: `QA4 Bakery ${run}`, slug: `qa4-${run}`, country: 'GB' },
  });
  await db.member.create({
    data: { id: randomUUID(), organizationId: orgId, userId: user.id, role: 'owner' },
  });
  await db.orgEntitlement.create({
    data: { organisationId: orgId, tier: 'PLUS', access: 'full', source: 'admin' },
  });
  const business = await db.business.create({
    data: { organisationId: orgId, name: `QA4 Sourdough ${run}`, createdByUserId: user.id },
  });
  businessId = business.id;
  await db.businessProfile.create({
    data: {
      organisationId: orgId,
      businessId,
      industry: 'bakery',
      subNiche: 'sourdough',
      products: ['sourdough', 'bakery'],
      services: [],
      audienceKeywords: ['morning'],
      toneIndicators: ['warm'],
      regions: ['GB'],
      imageThemes: [],
      imageSearchQueries: [],
      restrictedTopics: [],
      classifierModel: 'qa-stub',
    },
  });

  const categories = await db.videoLibraryCategory.findMany({
    orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }],
    take: 2,
  });
  expect(categories.length).toBe(2);
  const [first, second] = categories as [(typeof categories)[0], (typeof categories)[0]];
  const past = new Date(Date.now() - 86_400_000);
  ids.bakery = await seedItem(first.id, {
    key: 'bakery',
    title: titles.bakery,
    tags: ['bakery', 'sourdough'],
    durationSec: 21,
    mood: 'warm',
  });
  ids.gym = await seedItem(second.id, {
    key: 'gym',
    title: titles.gym,
    tags: ['fitness'],
    durationSec: 45,
    mood: 'energetic',
    scenario: 'LICENSED',
  });
  ids.scraped = await seedItem(first.id, {
    key: 'scraped',
    title: titles.scraped,
    tags: ['street'],
    durationSec: 12,
    mood: 'gritty',
    scenario: 'SCRAPED',
  });
  ids.expired = await seedItem(first.id, {
    key: 'expired',
    title: titles.expired,
    tags: ['expired'],
    durationSec: 20,
    mood: 'calm',
    scenario: 'LICENSED',
    expires: past,
  });
  ids.unlicensed = await seedItem(first.id, {
    key: 'unlicensed',
    title: titles.unlicensed,
    tags: ['unlicensed'],
    durationSec: 20,
    mood: 'calm',
    noLicence: true,
  });
  ids.retired = await seedItem(first.id, {
    key: 'retired',
    title: titles.retired,
    tags: ['retired'],
    durationSec: 20,
    mood: 'calm',
    retired: true,
  });
  // 26 more live references so the browse grid (24 a page) has a second page.
  for (let i = 0; i < 26; i += 1) {
    const title = `Filler ${String(i).padStart(2, '0')} ${run}`;
    fillerTitles.push(title);
    await seedItem(second.id, {
      key: `filler-${i}`,
      title,
      tags: ['filler'],
      durationSec: 70,
      mood: 'neutral',
    });
  }
  expect(Object.keys(ids)).toHaveLength(6);

  // `next dev` compiles a route on first use: visit every route once so the later tests time
  // the app, not the compiler (a no-op against a production build).
  await signIn(page, ownerEmail);
  ownerCookies = await page.context().cookies();
  for (const path of ['/library', `/library/${ids.bakery}`, '/templates', '/new', '/admin']) {
    await page.goto(path, { timeout: 180_000 });
    await page.waitForLoadState('networkidle', { timeout: 120_000 }).catch(() => undefined);
  }
});

test('browse: grid, filters, search, pagination and empty states', async ({ page }) => {
  test.setTimeout(240_000);
  const w = new Watcher(page);
  await stubStorage(page);
  await useBusiness(page, businessId);
  await useOwnerSession(page);
  await w.visit('/library');
  const grid = page.locator('section[aria-labelledby="library-browse"]');
  await expect(page.getByRole('heading', { name: 'Reference library' })).toBeVisible();

  // Pagination: 29 live references, 24 a page; unlicensed, expired-but-licensed and retired
  // follow the licence rules (unlicensed and retired never listed).
  const cards = grid.locator('ul > li');
  await expect(cards.first()).toBeVisible();
  await expect(grid.getByRole('link', { name: titles.unlicensed })).toHaveCount(0);
  await expect(grid.getByRole('link', { name: titles.retired })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Previous' })).toBeDisabled();
  await page.getByRole('button', { name: 'More references' }).click();
  await expect(page.getByRole('button', { name: 'Previous' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'More references' })).toBeDisabled();
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(page.getByRole('button', { name: 'Previous' })).toBeDisabled();

  // Tags filter (server side).
  await page.getByLabel('Tags').fill('sourdough');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(grid.getByRole('link', { name: new RegExp(titles.bakery) })).toBeVisible();
  await expect(grid.getByRole('link', { name: new RegExp(titles.gym) })).toHaveCount(0);
  await expect(grid.getByText('Template + Inspire').first()).toBeVisible();

  // Length filter: the 45 s reference is "30–60s", the 21 s one is "15–30s".
  await page.getByRole('button', { name: 'Clear' }).click();
  await page.getByLabel('Length').selectOption('long');
  await expect(grid.getByRole('link', { name: new RegExp(titles.gym) })).toBeVisible();
  await expect(grid.getByRole('link', { name: new RegExp(titles.bakery) })).toHaveCount(0);
  // 25.10: the filters live in the URL, so a filtered view survives a reload.
  await expect(page).toHaveURL(/[?&]length=long/);
  await page.reload();
  await expect(page.getByLabel('Length')).toHaveValue('long');
  await expect(grid.getByRole('link', { name: new RegExp(titles.gym) })).toBeVisible();
  await page.getByLabel('Length').selectOption('medium');
  await expect(grid.getByRole('link', { name: new RegExp(titles.bakery) })).toBeVisible();
  await page.getByLabel('Length').selectOption('any');

  // Mood filter.
  await page.getByLabel('Mood').fill('energ');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(grid.getByRole('link', { name: new RegExp(titles.gym) })).toBeVisible();
  await expect(grid.getByRole('link', { name: new RegExp(titles.bakery) })).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear' }).click();

  // Category filter: choosing a category narrows the grid; the tree is indented in the select.
  const options = await page.getByLabel('Category').locator('option').allInnerTexts();
  expect(options.length).toBeGreaterThan(10);
  expect(options.some((o) => o.includes('└'))).toBe(true);

  // Inspire-only chip for the SCRAPED reference.
  await page.getByLabel('Tags').fill('street');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(grid.getByText('Inspire only')).toBeVisible();
  await page.getByRole('button', { name: 'Clear' }).click();

  // Free-text search ranks the matching reference first and shows a match %.
  await page.getByLabel('Search the library').fill('sourdough bakery morning');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('status')).toContainText('sourdough bakery morning');
  const first = cards.first();
  await expect(first).toContainText(titles.bakery);
  await expect(first).toContainText('% match');
  // 20.30: a reference that is not close to the query is no longer listed with a weak percentage.
  await expect(grid.getByRole('link', { name: new RegExp(titles.gym) })).toHaveCount(0);
  // The length, mood and tag filters narrow a search too (the 45 s gym reference is "30–60s").
  await page.getByLabel('Search the library').fill('gym motivation');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(grid.getByRole('link', { name: new RegExp(titles.gym) })).toBeVisible();
  await page.getByLabel('Length').selectOption('long');
  await expect(cards).toHaveCount(1);
  await expect(grid.getByRole('link', { name: new RegExp(titles.gym) })).toBeVisible();
  await expect(page.getByRole('status')).not.toContainText(/don’t apply/);
  await page.getByLabel('Length').selectOption('any');
  await page.getByLabel('Tags').fill('fitness');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(cards).toHaveCount(1);
  await expect(grid.getByRole('link', { name: new RegExp(titles.gym) })).toBeVisible();
  await page.getByLabel('Tags').fill('');
  await page.getByLabel('Search the library').fill('sourdough bakery morning');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(first).toContainText(titles.bakery);
  // No close matches: a message with categories to browse, not unrelated references.
  await page.getByLabel('Search the library').fill('zzzzqqqq');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('No close matches for “zzzzqqqq”')).toBeVisible();
  // The suggestions are category buttons, not reference cards.
  await expect(grid.getByRole('link', { name: new RegExp(titles.bakery) })).toHaveCount(0);
  await expect(grid.getByRole('link', { name: new RegExp(titles.gym) })).toHaveCount(0);
  await expect(grid.locator('ul > li button').first()).toBeVisible();
  await w.settle();
  await page.getByRole('button', { name: 'Clear' }).click();
  // Empty filter state.
  await page.getByLabel('Tags').fill('no-such-tag-anywhere');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('No references match')).toBeVisible();
  await expect(page.getByText('Try a broader category or fewer tags.')).toBeVisible();
  w.expectClean();
});

test('recommended shelf, hover preview and keyboard', async ({ page }) => {
  const w = new Watcher(page);
  await stubStorage(page);
  await useBusiness(page, businessId);
  await useOwnerSession(page);
  await w.visit('/library');
  const shelf = page.getByRole('region', { name: 'Picked for your business' });
  await expect(shelf.getByRole('list', { name: 'Recommended for your business' })).toBeVisible();
  await expect(shelf.getByRole('listitem').first()).toContainText(titles.bakery);

  // Hover (and focus) loads the muted preview in place.
  const card = page.getByRole('link', { name: new RegExp(titles.bakery) }).first();
  await card.hover();
  await expect(page.getByTestId('hover-preview').first()).toBeAttached({ timeout: 10_000 });
  // Keyboard: Enter on a focused card opens the detail page.
  await card.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/library/${ids.bakery}$`));
  w.expectClean();

  // No business selected: a prompt instead of the shelf.
  const other = await page.context().newPage();
  await stubStorage(other);
  await useBusiness(other, null);
  await other.goto('/library');
  await expect(
    other.getByText(/Pick a business in the top bar|No business profile yet/),
  ).toBeVisible();
  await other.close();
});

test('detail: player, blueprint, similar videos and the two ways into Create', async ({ page }) => {
  test.setTimeout(180_000);
  const w = new Watcher(page);
  await stubStorage(page);
  await useBusiness(page, businessId);
  await useOwnerSession(page);
  await w.visit(`/library/${ids.bakery}`);
  await expect(page.getByRole('heading', { name: titles.bakery })).toBeVisible();
  const player = page.locator('video[controls]');
  await expect(player).toHaveAttribute('src', /ci-library/);
  await expect(player).toHaveAttribute('poster', /\.jpg/);
  await expect(page.getByRole('list', { name: 'Shot list' }).getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('list', { name: 'Tags' })).toContainText('sourdough');
  await expect(page.getByRole('region', { name: 'More like this' })).toBeVisible();
  // The similar shelf never lists the video itself, nor unlicensed or retired ones.
  const similar = page.getByRole('list', { name: 'Similar references' });
  await expect(similar).toBeVisible();
  await expect(similar).not.toContainText(titles.bakery);
  await expect(similar).not.toContainText(titles.unlicensed);
  await expect(similar).not.toContainText(titles.retired);

  for (const [name, mode] of [
    ['Same video, my content', 'TEMPLATE'],
    ['Make one like this', 'INSPIRE'],
  ] as const) {
    await page.getByRole('link', { name: new RegExp(name) }).click();
    await expect(page).toHaveURL(new RegExp(`/new\\?reference=${ids.bakery}&mode=${mode}`));
    await expect(page.getByText('From the reference library')).toBeVisible();
    await expect(page.getByText(titles.bakery)).toBeVisible();
    await expect(
      page.getByRole('radio', { name: mode === 'TEMPLATE' ? 'Template' : 'Inspire' }),
    ).toHaveAttribute('aria-checked', 'true');
    // Create shows what the reference will do: the shot structure (TEMPLATE) or the style (INSPIRE).
    await expect(
      page.getByRole('heading', {
        name: mode === 'TEMPLATE' ? 'What Studio will follow' : 'What Studio will borrow',
      }),
    ).toBeVisible();
    if (mode === 'TEMPLATE')
      await expect(page.getByRole('list', { name: 'Shot list' })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', { name: titles.bakery })).toBeVisible();
  }
  // In Create the mode can be switched and the reference cleared.
  await page.goto(`/new?reference=${ids.bakery}&mode=TEMPLATE`);
  await page.getByRole('radio', { name: 'Inspire' }).click();
  await expect(page.getByRole('radio', { name: 'Inspire' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByRole('button', { name: 'Don’t use a reference' }).click();
  await expect(page.getByText('From the reference library')).toHaveCount(0);
  w.expectClean();
});

test('licence rules: scraped is Inspire only, expired and unlicensed are not usable', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const w = new Watcher(page);
  await stubStorage(page);
  await useBusiness(page, businessId);
  await useOwnerSession(page);

  // SCRAPED: Template locked, Inspire open, no blueprint.
  await w.visit(`/library/${ids.scraped}`);
  await expect(page.getByRole('link', { name: /Make one like this/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Same video, my content/ })).toHaveCount(0);
  await expect(page.getByText(/Inspire-only reference/)).toBeVisible();
  const apiScraped = await page.request.get(`/api/studio/library/blueprint/${ids.scraped}`);
  expect((await apiScraped.json()).blueprint).toBeNull();

  // Expired licence: the library must not offer either action (create would answer 409).
  await w.visit(`/library/${ids.expired}`);
  await expect(page.getByRole('link', { name: /Same video, my content/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Make one like this/ })).toHaveCount(0);
  await expect(page.getByText('Not available for this reference under its licence.')).toHaveCount(
    2,
  );

  // Unlicensed, retired and unknown ids are "not found" (and the API says 404).
  for (const id of [ids.unlicensed, ids.retired, 'does-not-exist']) {
    await w.visit(`/library/${id}`);
    await expect(page.getByText('Reference not found')).toBeVisible();
    expect((await page.request.get(`/api/studio/library/videos/${id}`)).status()).toBe(404);
  }
  w.expectClean();
});

test('detail error state retries', async ({ page }) => {
  const w = new Watcher(page);
  await stubStorage(page);
  await useOwnerSession(page);
  let fail = true;
  await page.route(`**/api/studio/library/videos/${ids.gym}`, (route) =>
    fail
      ? route.fulfill({ status: 500, json: { ok: false, error: { code: 'internal' } } })
      : route.continue(),
  );
  w.paused = true;
  await page.goto(`/library/${ids.gym}`);
  const retry = page.getByRole('button', { name: 'Retry' });
  await expect(retry).toBeVisible();
  fail = false;
  w.paused = false;
  await retry.click();
  await expect(page.getByRole('heading', { name: titles.gym })).toBeVisible();
  w.expectClean();
});

test('templates: list, delete, empty states, error retry and the Create picker', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const w = new Watcher(page);
  await useOwnerSession(page);
  const formats = [{ platform: 'TIKTOK', aspectRatio: '9:16', duration: 15 }];
  await w.visit('/templates');
  await expect(page.getByRole('heading', { name: 'Templates', exact: true })).toBeVisible();
  // Nothing saved yet: both empty hints show.
  await expect(page.getByText(/Save a slideshow as a template/)).toBeVisible();
  await expect(page.getByText(/Save a project as a template/)).toBeVisible();

  await db.template.create({
    data: {
      organisationId: orgId,
      name: `QA project template ${run}`,
      category: 'weekly_special',
      targetFormats: formats,
      scriptTemplate: '{{brief}}',
      shotBlueprint: {
        shots: [
          { durationSec: 3, type: 'HOOK_TEXT_ON_STILL' },
          { durationSec: 4, type: 'PRODUCT_SHOT' },
        ],
      },
    },
  });
  await db.slideshowTemplate.create({
    data: {
      organisationId: orgId,
      name: `QA slideshow template ${run}`,
      category: 'photo_dump',
      slidePlan: [],
    },
  });
  await w.visit('/templates');
  const slideshows = page.getByRole('list', { name: 'slideshow templates' });
  const projects = page.getByRole('list', { name: 'project templates' });
  await expect(slideshows).toContainText(`QA slideshow template ${run}`);
  await expect(slideshows).toContainText('photo dump');
  await expect(projects).toContainText(`QA project template ${run}`);
  await expect(projects).toContainText('weekly special');

  // The Create screen offers the saved project template.
  await page.goto('/new');
  await page.getByRole('button', { name: 'More options' }).click();
  const picker = page.getByRole('radiogroup', { name: 'Video template' });
  await expect(picker.getByRole('radio', { name: /No template/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await picker.getByRole('radio', { name: new RegExp(`QA project template ${run}`) }).click();
  await expect(
    picker.getByRole('radio', { name: new RegExp(`QA project template ${run}`) }),
  ).toHaveAttribute('aria-checked', 'true');
  await picker.getByRole('radio', { name: /No template/ }).click();

  // Error state and retry.
  await page.goto('/templates');
  await w.settle();
  w.paused = true;
  let fail = true;
  await page.route('**/api/studio/templates', (route) =>
    fail
      ? route.fulfill({ status: 500, json: { ok: false, error: { code: 'internal' } } })
      : route.continue(),
  );
  await page.reload();
  const retry = page.getByRole('button', { name: 'Retry' });
  await expect(retry).toBeVisible();
  fail = false;
  w.paused = false;
  await retry.click();
  await expect(projects).toContainText(`QA project template ${run}`);

  // Preview, then "Use template" opens Create with the template applied.
  await page.getByRole('button', { name: `Preview QA project template ${run}` }).click();
  const preview = page.getByRole('dialog', { name: new RegExp(`QA project template ${run}`) });
  await expect(preview.getByRole('list', { name: 'Formats' })).toContainText('9:16');
  await expect(preview.getByRole('list', { name: 'Shot list' })).toBeVisible();
  await preview.getByRole('button', { name: 'Close', exact: true }).first().click();
  await page.getByRole('link', { name: `Use QA project template ${run}` }).click();
  await expect(page).toHaveURL(/\/new\?template=/);
  await expect(
    page.getByRole('radio', { name: new RegExp(`QA project template ${run}`) }),
  ).toHaveAttribute('aria-checked', 'true');
  await page.goto('/templates');
  await page.getByRole('link', { name: `Use QA slideshow template ${run}` }).click();
  await expect(page).toHaveURL(/\/new\?slideshowTemplate=/);
  await expect(
    page.getByRole('radio', { name: new RegExp(`QA slideshow template ${run}`) }),
  ).toHaveAttribute('aria-checked', 'true');
  await page.goto('/templates');

  // Delete asks first: cancelling keeps the template; confirming deletes both.
  await page.getByRole('button', { name: `Delete QA project template ${run}` }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
  expect(await db.template.count({ where: { organisationId: orgId } })).toBe(1);
  await page.getByRole('button', { name: `Delete QA project template ${run}` }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete template' }).click();
  await expect(page.getByText(`Deleted “QA project template ${run}”`).first()).toBeVisible();
  await page.getByRole('button', { name: `Delete QA slideshow template ${run}` }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete template' }).click();
  await expect(page.getByText(`Deleted “QA slideshow template ${run}”`).first()).toBeVisible();
  await expect(page.getByText(/Save a project as a template/)).toBeVisible();
  expect(await db.template.count({ where: { organisationId: orgId } })).toBe(0);
  expect(await db.slideshowTemplate.count({ where: { organisationId: orgId } })).toBe(0);

  // Built-in templates are read-only: the API refuses to delete one.
  const builtIn = await db.template.findFirst({ where: { organisationId: null } });
  if (builtIn) {
    const res = await page.request.delete(`/api/studio/templates/${builtIn.id}`, {
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(res.status()).toBe(403);
  }
  w.expectClean();
});

test('mobile, dark mode and right-to-left render without overflow', async ({ page }) => {
  test.setTimeout(240_000);
  const w = new Watcher(page);
  await stubStorage(page);
  await useBusiness(page, businessId);
  await page.setViewportSize({ width: 375, height: 800 });
  await useOwnerSession(page);
  for (const path of ['/library', `/library/${ids.bakery}`, '/templates']) {
    await w.visit(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} overflows horizontally at 375 px`).toBeLessThanOrEqual(1);
  }
  // 25.4: appearance and language live in the account menu (top bar, every width).
  await chooseTheme(page, 'Dark');
  await expect(page.locator('html')).toHaveClass(/dark/);
  await w.visit('/library');
  await chooseLanguage(page, /العربية/);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  for (const path of ['/library', `/library/${ids.bakery}`, '/templates']) {
    await w.visit(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} overflows in RTL`).toBeLessThanOrEqual(1);
  }
  w.expectClean();
});

test('staff: the Library tab lists, edits, bulk-reviews and retires; others are refused', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const w = new Watcher(page);
  await stubStorage(page);
  // A non-staff owner is refused by the staff API.
  await useOwnerSession(page);
  expect((await page.request.get('/api/studio/admin/library/videos')).status()).toBe(403);
  // Leave the signed-in app first: its pollers would answer 401 once the cookies are gone.
  await page.goto('about:blank');
  await page.context().clearCookies();

  w.noOrganisation = true;
  await signUp(page, staffEmail, 'QA Staff');
  await db.user.update({ where: { email: staffEmail }, data: { role: 'superadmin' } });
  await signIn(page, staffEmail);
  await enableTwoFactor(page, password);
  await expect(page.getByText('Two-step verification is on.').first()).toBeVisible();

  // From here on a 403 other than no_organisation is an error.
  w.noOrganisation = false;
  w.current = '/admin library';
  await page.goto('/admin');
  await page
    .getByRole('navigation', { name: 'Admin sections' })
    .getByRole('link', { name: 'Library' })
    .click();
  await w.settle();
  const list = page.getByRole('list', { name: 'Corpus items' });
  // The filter box is debounced; filter to one title at a time (the corpus has 32 rows here).
  const find = async (title: string) => {
    await page.getByLabel('Search', { exact: true }).fill(title);
    await expect(list.getByRole('listitem')).toHaveCount(1, { timeout: 60_000 });
  };
  await expect(list).toBeVisible();
  await find(titles.bakery);
  await expect(list).toContainText(titles.bakery);
  await find(titles.unlicensed);
  await expect(list).toContainText('No licence');
  await find(titles.expired);
  await expect(list).toContainText('Licence expired');
  // Retired rows are hidden by the default "Live" status filter.
  await page.getByLabel('Search', { exact: true }).fill(titles.retired);
  await expect(page.getByText('No items match these filters.')).toBeVisible();
  await page.locator('#admin-library-retired').selectOption('true');
  await expect(list).toContainText(titles.retired);
  await expect(list.getByRole('button', { name: /^Retire / })).toHaveCount(0);
  await page.locator('#admin-library-retired').selectOption('false');

  // Edit: rename.
  await find(titles.gym);
  await page.getByRole('button', { name: `Edit ${titles.gym}` }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title').fill(`${titles.gym} renamed`);
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Library video updated').first()).toBeVisible();
  expect((await db.videoLibraryItem.findUniqueOrThrow({ where: { id: ids.gym } })).title).toBe(
    `${titles.gym} renamed`,
  );

  // Bulk accept one row.
  await find(titles.bakery);
  await page.getByRole('checkbox', { name: `Select ${titles.bakery}` }).check();
  await page.getByRole('button', { name: 'Accept category' }).click();
  await expect(page.getByText(/Category accepted for 1 item/).first()).toBeVisible();

  // Retire with confirmation: leaves the user library.
  await find(titles.scraped);
  await page.getByRole('button', { name: `Retire ${titles.scraped}` }).click();
  await page.getByRole('button', { name: 'Retire', exact: true }).last().click();
  await expect(page.getByText(`“${titles.scraped}” retired`).first()).toBeVisible();
  expect(
    (await db.videoLibraryItem.findUniqueOrThrow({ where: { id: ids.scraped } })).retiredAt,
  ).not.toBeNull();
  w.expectClean();
});
