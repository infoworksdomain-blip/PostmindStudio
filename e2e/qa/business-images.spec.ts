import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import {
  PIXEL,
  addMember,
  pngBytes,
  removeBusinessData,
  seedImages,
  seedProfile,
  seedScan,
  sessionFor,
  stubImages,
} from './business-images.fixtures';
import {
  Watcher,
  createAccount,
  queueWorks,
  randomIp,
  removeAccount,
  type Account,
} from './support';

// QA 6: Business & Images (/business: profile, website scan, brand kits, hashtags, image library,
// what Studio has learned; the header business switcher) and Connections (/connections), through
// the real UI with Prisma fixtures and the sweep's error detection. The scan worker's job is done
// by database rows (a real worker needs Redis 5+); the embedding API and object storage are local
// stubs (e2e/qa/embedding-stub.cjs, e2e/qa/s3-stub.mjs); Pexels has no key. No paid API is called.
// Inventory: e2e/qa/business-images.inventory.md.

const hasDb = Boolean(process.env.DATABASE_URL);
test.skip(!hasDb, 'DATABASE_URL is not set: needs the app’s database');
// One worker runs the tests in file order; a failure does not skip the rest (each test seeds or
// cleans what it needs, so a single failure shows alone).
test.describe.configure({ timeout: 240_000 });

const run = randomUUID().slice(0, 8);
let db: PrismaClient;
let baseURL = '';
let owner: Account;
let basic: Account;
let viewerEmail = '';
let ownerState = '';
let basicState = '';
let viewerState = '';
let queueOk = false;

async function newPage(
  browser: Browser,
  state: string,
  opts: { width?: number; dark?: boolean; locale?: string } = {},
): Promise<Page> {
  const context = await browser.newContext({
    storageState: state,
    locale: opts.locale ?? 'en-GB',
    viewport: { width: opts.width ?? 1280, height: 900 },
    extraHTTPHeaders: { 'x-real-ip': randomIp() },
    colorScheme: opts.dark ? 'dark' : 'light',
  });
  const page = await context.newPage();
  await stubImages(page);
  return page;
}

/** QA6_SHOTS=<dir> saves a screenshot at each step (review aid; not an assertion). */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.QA6_SHOTS;
  if (!dir) return;
  await page
    .screenshot({ path: `${dir}/${name.replace(/[^a-z0-9]+/gi, '_')}.png`, fullPage: true })
    .catch(() => undefined);
}

async function openTab(page: Page, w: Watcher, tab: string, name: string): Promise<void> {
  w.label(`/business ${tab}`);
  await page.goto(`/business?tab=${tab}`);
  await expect(page.getByRole('tab', { name, selected: true })).toBeVisible();
  await w.settle();
  await shot(page, `${test.info().title.slice(0, 40)}-${tab}`);
}

/** The Connections banner (the route announcer is also an alert, always empty). */
const notice = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

async function toast(page: Page, text: string | RegExp): Promise<void> {
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: text }).first()).toBeVisible();
}

test.beforeAll(async ({ browser, request }) => {
  test.setTimeout(480_000);
  db = new PrismaClient();
  baseURL = test.info().project.use.baseURL ?? 'http://127.0.0.1:3102';
  owner = await createAccount(db, request, baseURL, { label: 'bi-owner', tier: 'PLUS' });
  basic = await createAccount(db, request, baseURL, { label: 'bi-basic', tier: 'BASIC' });
  const viewer = await addMember(db, request, baseURL, owner.organisationId, 'viewer');
  viewerEmail = viewer.email;
  await seedProfile(db, owner, { needsReview: true, confidence: 0.55 });
  queueOk = await queueWorks();
  ownerState = test.info().outputPath('bi-owner.json');
  basicState = test.info().outputPath('bi-basic.json');
  viewerState = test.info().outputPath('bi-viewer.json');
  await sessionFor(browser, owner.email, ownerState);
  await sessionFor(browser, basic.email, basicState);
  await sessionFor(browser, viewerEmail, viewerState);
});

test.afterAll(async () => {
  if (!db) return;
  for (const account of [owner, basic]) {
    if (!account) continue;
    await removeBusinessData(db, account.organisationId);
    await db.member.deleteMany({ where: { organizationId: account.organisationId } });
    await removeAccount(db, account);
  }
  await db.$disconnect();
});

test.describe('business switcher', () => {
  test('adds a second business, rejects a duplicate, switches and remembers the choice', async ({
    browser,
  }) => {
    const page = await newPage(browser, ownerState);
    const w = new Watcher(page, [
      { method: 'POST', url: /\/api\/studio\/businesses$/, status: 409 },
    ]);
    w.label('switcher');
    await page.goto('/business');
    const select = page.locator('#business-select');
    await expect(select).toBeVisible();
    await expect(select.locator('option', { hasText: owner.businessName })).toHaveCount(1);

    const second = `QA Deli ${run}`;
    await page.getByRole('button', { name: 'Add a business' }).click();
    await page.getByLabel('Business name').or(page.locator('#business-new')).first().fill(second);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await toast(page, `${second} added`);
    await expect(select.locator('option:checked')).toHaveText(second);
    // The new business has no profile yet.
    await expect(page.getByText('No business profile yet')).toBeVisible();

    // A duplicate name (any case) is refused with the server's message; the form stays usable.
    await page.getByRole('button', { name: 'Add a business' }).click();
    await page.locator('#business-new').fill(second.toUpperCase());
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await toast(page, /already exists/);
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Switch back; the choice survives a reload.
    await page.locator('#business-select').selectOption({ label: owner.businessName });
    await page.reload();
    await expect(page.locator('#business-select option:checked')).toHaveText(owner.businessName);
    await w.settle();
    await w.check();
    w.assertClean();
    await page.context().close();
  });

  test('a business with no profile yet leads from the profile tab to the scan', async ({
    browser,
  }) => {
    const empty = await db.business.create({
      data: {
        organisationId: owner.organisationId,
        name: `QA Empty ${run}`,
        createdByUserId: owner.userId,
      },
    });
    const page = await newPage(browser, ownerState);
    await page.addInitScript(
      (id) => window.localStorage.setItem('studio.businessId', id),
      empty.id,
    );
    const w = new Watcher(page);
    w.label('empty profile');
    await page.goto('/business');
    await expect(page.getByText('No business profile yet')).toBeVisible();
    await page.getByRole('button', { name: 'Scan your website' }).click();
    await expect(page.getByRole('tab', { name: 'Website scan', selected: true })).toBeVisible();
    await w.settle();
    await w.check();
    w.assertClean();
    await page.context().close();
    await db.business.delete({ where: { id: empty.id } });
  });
});

test.describe('profile', () => {
  test('edit, validate, discard, save and confirm a low-confidence profile', async ({
    browser,
  }) => {
    const page = await newPage(browser, ownerState);
    const w = new Watcher(page);
    await openTab(page, w, 'profile', 'Profile');
    await expect(page.getByText('artisan sourdough')).toBeVisible();
    await expect(page.getByRole('status', { name: 'Profile needs your review' })).toContainText(
      '55%',
    );
    await page.getByRole('button', { name: 'Confirm profile' }).click();
    await toast(page, 'Business profile confirmed');
    await expect(page.getByRole('status', { name: 'Profile needs your review' })).toHaveCount(0);

    const save = page.getByRole('button', { name: 'Save profile' });
    await expect(save).toBeDisabled();
    await page.getByLabel('Industry').fill('');
    await expect(
      page.getByText(/Industry, niche and at least one stock image search/),
    ).toBeVisible();
    await expect(save).toBeDisabled();
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await expect(page.getByLabel('Industry')).toHaveValue('Food and drink');

    await page.getByLabel('Industry').fill('Bakery and cafe');
    await page.getByLabel('Stock image searches').fill('');
    await expect(save).toBeDisabled();
    await page.getByLabel('Stock image searches').fill('sourdough, bakery interior, , sourdough');
    await save.click();
    await toast(page, 'Business profile saved');
    const row = await db.businessProfile.findFirstOrThrow({
      where: { businessId: owner.businessId },
    });
    expect(row).toMatchObject({ industry: 'Bakery and cafe', editedByUser: true });
    expect(row.imageSearchQueries).toEqual(['sourdough', 'bakery interior']);
    await expect(page.getByText(/Edited by you/)).toBeVisible();
    await w.check();
    w.assertClean();
    await page.context().close();
  });
});

test.describe('website scan', () => {
  test('the form needs an address and the ownership confirmation; empty history', async ({
    browser,
  }) => {
    const page = await newPage(browser, ownerState);
    const w = new Watcher(page, [{ method: 'POST', url: /scan-website$/, status: 400 }]);
    await openTab(page, w, 'scan', 'Website scan');
    await expect(page.getByText('No scans yet.')).toBeVisible();
    const submit = page.getByRole('button', { name: 'Scan website' });
    await expect(submit).toBeDisabled();
    await page.getByLabel('Website address').fill('qa-bakery.example');
    await expect(submit).toBeDisabled();
    await page.getByLabel(/I own this website/).check();
    await expect(submit).toBeEnabled();
    await expect(page.getByTestId('scan-render-policy')).toContainText('bot check');
    // An address that can never be scanned is refused with a readable message, not a crash.
    await page.getByLabel('Website address').fill('ftp://qa-bakery.example');
    await submit.click();
    await expect(page.locator('[data-sonner-toast]').first()).toContainText(/http/i);
    await expect(page.getByText('No scans yet.')).toBeVisible();
    w.assertClean();
    await page.context().close();
  });

  test('shows a running scan, then its result when the worker finishes', async ({ browser }) => {
    const scanId = await seedScan(db, owner, {
      state: 'RUNNING',
      pagesCrawled: 3,
      startedAt: new Date(Date.now() - 60_000),
    });
    const page = await newPage(browser, ownerState);
    const w = new Watcher(page);
    await openTab(page, w, 'scan', 'Website scan');
    await expect(page.getByText('Scanning your site').first()).toBeVisible();
    await expect(page.locator('dl dd').first()).toHaveText('3');
    // The worker finishes: the open card follows (it polls every 3 s) and the history updates.
    await seedImages(db, owner, [
      { source: 'SCRAPED', altText: 'Golden loaf', tags: ['bread'] },
      { source: 'STOCK', tags: ['bakery'], hotlinked: true },
    ]);
    await db.websiteScan.update({
      where: { id: scanId },
      data: { state: 'SUCCEEDED', pagesCrawled: 7, imagesIngested: 2, completedAt: new Date() },
    });
    await expect(page.getByText('Done').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('dl dd').first()).toHaveText('7');
    await expect(page.getByText('1 from your site · 1 stock')).toBeVisible();
    w.assertClean();
    await page.context().close();
  });

  test('a scan that finished with warnings shows one plain sentence per kind', async ({
    browser,
  }) => {
    // What the worker stores now (scan/warnings.ts): one coded line per kind of problem.
    await db.websiteScan.deleteMany({ where: { businessId: owner.businessId } });
    await seedScan(db, owner, {
      state: 'SUCCEEDED',
      pagesCrawled: 4,
      imagesIngested: 0,
      url: 'https://warn.qa-bakery.example/',
      errorReason: ['scan_pages_skipped: 1', 'scan_images_skipped: 2', 'stock_not_configured'].join(
        '\n',
      ),
    });
    const page = await newPage(browser, ownerState);
    const w = new Watcher(page);
    await openTab(page, w, 'scan', 'Website scan');
    const card = page.locator('[aria-live="polite"]').first();
    await expect(card).toContainText('warn.qa-bakery.example');
    const text = await card.innerText();
    expect(text).toContain('1 page could not be read and was skipped.');
    expect(text).toContain('2 images on your site could not be downloaded and were skipped.');
    expect(text).toContain('no stock photo service is set up yet');
    expect(text).not.toContain('This step failed');
    w.assertClean();
    await page.context().close();
  });

  test('scans stored before that (raw lines) show no raw text and no wall of repeats', async ({
    browser,
  }) => {
    await db.websiteScan.deleteMany({ where: { businessId: owner.businessId } });
    await seedScan(db, owner, {
      state: 'SUCCEEDED',
      pagesCrawled: 4,
      url: 'https://legacy.qa-bakery.example/',
      errorReason: [
        'https://legacy.qa-bakery.example/img/a.jpg: connect ECONNREFUSED 10.0.0.5:443',
        'https://legacy.qa-bakery.example/img/b.jpg: connect ECONNREFUSED 10.0.0.5:443',
        'No stock image provider configured (PEXELS_API_KEY, STORYBLOCKS_API_*_KEY or UNSPLASH_ACCESS_KEY)',
      ].join('\n'),
    });
    const page = await newPage(browser, ownerState);
    const w = new Watcher(page);
    await openTab(page, w, 'scan', 'Website scan');
    const card = page.locator('[aria-live="polite"]').first();
    await expect(card).toContainText('legacy.qa-bakery.example');
    const text = await card.innerText();
    expect(text).not.toMatch(/ECONNREFUSED|PEXELS_API_KEY|10.0.0.5/);
    expect((text.match(/This step failed/g) ?? []).length).toBeLessThanOrEqual(1);
    w.assertClean();
    await page.context().close();
  });

  test('failed scans explain why: robots.txt and no pages', async ({ browser }) => {
    await db.websiteScan.deleteMany({ where: { businessId: owner.businessId } });
    await seedScan(db, owner, {
      state: 'FAILED',
      url: 'https://blocked.qa-bakery.example/',
      robotsBlocked: true,
      errorReason:
        "robots_blocked: The site's robots.txt does not allow PostMindStudio to fetch the homepage",
      startedAt: new Date(Date.now() - 1_000),
    });
    const page = await newPage(browser, ownerState);
    const w = new Watcher(page);
    await openTab(page, w, 'scan', 'Website scan');
    await expect(page.getByText('Failed').first()).toBeVisible();
    await expect(page.getByText(/robots\.txt asked us not to read/)).toBeVisible();
    await db.websiteScan.deleteMany({ where: { businessId: owner.businessId } });
    await seedScan(db, owner, {
      state: 'FAILED',
      url: 'https://down.qa-bakery.example/',
      errorReason: 'no_pages: No pages could be fetched',
    });
    await page.reload();
    await expect(page.getByText('Failed').first()).toBeVisible();
    await expect(page.locator('[aria-live="polite"]').first()).not.toContainText('no_pages');
    w.assertClean();
    await page.context().close();
  });

  test('starting a scan while one is running follows the running scan', async ({ browser }) => {
    await db.websiteScan.deleteMany({ where: { businessId: owner.businessId } });
    const running = await seedScan(db, owner, {
      state: 'RUNNING',
      url: 'https://busy.qa-bakery.example/',
    });
    const page = await newPage(browser, ownerState);
    const w = new Watcher(page, [{ method: 'POST', url: /scan-website$/, status: 409 }]);
    await openTab(page, w, 'scan', 'Website scan');
    await page.getByLabel('Website address').fill('qa-bakery.example');
    await page.getByLabel(/I own this website/).check();
    await page.getByRole('button', { name: 'Scan website' }).click();
    await toast(page, /already in progress/);
    await expect(page.getByText('busy.qa-bakery.example').first()).toBeVisible();
    await db.websiteScan.update({ where: { id: running }, data: { state: 'FAILED' } });
    w.assertClean();
    await page.context().close();
  });

  test('a real scan is queued and rescanning works (needs Redis 5+)', async ({ browser }) => {
    test.skip(!queueOk, 'BullMQ needs Redis 5+: this machine has an older Redis; CI runs it');
    await db.websiteScan.deleteMany({ where: { businessId: owner.businessId } });
    const page = await newPage(browser, ownerState);
    const w = new Watcher(page);
    await openTab(page, w, 'scan', 'Website scan');
    await page.getByLabel('Website address').fill('qa-bakery.example');
    await page.getByLabel(/I own this website/).check();
    await page.getByRole('button', { name: 'Scan website' }).click();
    await toast(page, /Scan started/);
    await expect(page.getByText('Queued').first()).toBeVisible();
    const scan = await db.websiteScan.findFirstOrThrow({ where: { businessId: owner.businessId } });
    expect(scan).toMatchObject({ state: 'QUEUED', url: 'https://qa-bakery.example/' });
    expect(scan.ownershipStatement).toContain('I own this website');
    // Rescan: finish this one, scan again.
    await db.websiteScan.update({ where: { id: scan.id }, data: { state: 'SUCCEEDED' } });
    await page.reload();
    await page.getByLabel('Website address').fill('qa-bakery.example');
    await page.getByLabel(/I own this website/).check();
    await page.getByRole('button', { name: 'Scan website' }).click();
    await toast(page, /Scan started/);
    expect(await db.websiteScan.count({ where: { businessId: owner.businessId } })).toBe(2);
    await db.websiteScan.updateMany({
      where: { businessId: owner.businessId },
      data: { state: 'FAILED' },
    });
    w.assertClean();
    await page.context().close();
  });

  test('without a plan a scan stops at the upgrade dialog', async ({ browser, request }) => {
    const free = await createAccount(db, request, baseURL, { label: 'bi-free', tier: null });
    const state = test.info().outputPath('bi-free.json');
    await sessionFor(browser, free.email, state);
    const page = await newPage(browser, state);
    const w = new Watcher(page, [{ method: 'POST', url: /scan-website$/, status: 402 }]);
    await openTab(page, w, 'scan', 'Website scan');
    await page.getByLabel('Website address').fill('qa-bakery.example');
    await page.getByLabel(/I own this website/).check();
    await page.getByRole('button', { name: 'Scan website' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await db.websiteScan.count({ where: { organisationId: free.organisationId } })).toBe(0);
    w.assertClean();
    await page.context().close();
    await removeAccount(db, free);
  });
});

test.describe('brand kits', () => {
  test('create with validation, edit, make default, upload a logo, delete', async ({ browser }) => {
    const page = await newPage(browser, ownerState);
    const w = new Watcher(page, [
      { method: 'POST', url: /\/uploads\/[^/]+\/complete$/, status: 400 },
    ]);
    await openTab(page, w, 'brand', 'Brand kits');
    await expect(page.getByText('No brand kit yet')).toBeVisible();

    await page.getByRole('button', { name: 'New brand kit' }).click();
    const dialog = page.getByRole('dialog');
    const create = dialog.getByRole('button', { name: 'Create kit' });
    await expect(create).toBeDisabled();
    await dialog.getByLabel('Name', { exact: true }).fill('Dawn');
    await dialog.getByLabel('Colours').fill('#D6452B, red');
    await expect(dialog.getByRole('alert')).toContainText('red is not a #RRGGBB colour');
    await expect(create).toBeDisabled();
    await dialog.getByLabel('Colours').fill('#d6452b, #1F2A44');
    await dialog.getByLabel('Heading font').fill('Bad/Font');
    await expect(dialog.getByRole('alert')).toContainText('not a valid font name');
    await dialog.getByLabel('Heading font').fill('Inter');
    await dialog.getByLabel('Tone', { exact: true }).fill('warm, crafted');
    await dialog.getByLabel('Calls to action').fill('Order | Order your loaf at {url}');
    await create.click();
    await toast(page, 'Dawn created');
    const card = page.getByRole('listitem').filter({ hasText: 'Dawn' }).first();
    await expect(card.getByText('Default', { exact: true })).toBeVisible();

    // A second kit, then make it the default.
    await page.getByRole('button', { name: 'New brand kit' }).click();
    await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Dusk');
    await page.getByRole('dialog').getByRole('button', { name: 'Create kit' }).click();
    await toast(page, 'Dusk created');
    await page.getByRole('button', { name: 'Make Dusk the default' }).click();
    await toast(page, 'Dusk is now the default kit');
    expect(
      (await db.brandKit.findMany({ where: { businessId: owner.businessId } })).filter(
        (k) => k.isDefault,
      ),
    ).toHaveLength(1);

    // Edit.
    await page.getByRole('button', { name: 'Edit Dawn' }).click();
    await page.getByRole('dialog').getByLabel('Audience').fill('Leeds families');
    await page.getByRole('dialog').getByRole('button', { name: 'Save kit' }).click();
    await toast(page, 'Dawn saved');
    expect((await db.brandKit.findFirstOrThrow({ where: { name: 'Dawn' } })).audienceProfile).toBe(
      'Leeds families',
    );

    // Logo upload: presigned PUT (answered locally), then the server checks the stored bytes.
    // The local object store returns zeros, so the check refuses the file: the person gets a
    // plain message and the kit is untouched (the success path is covered by vitest).
    await page
      .getByLabel('Upload logo for Dawn')
      .setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PIXEL });
    await toast(page, /rejected|not a/i);
    expect(
      (await db.brandKit.findFirstOrThrow({ where: { name: 'Dawn' } })).logoAssetId,
    ).toBeNull();

    // Delete behind a confirmation; cancelling keeps it.
    await page.getByRole('button', { name: 'Delete Dusk' }).click();
    await page.getByRole('button', { name: 'Keep it' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: 'Dusk' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Delete Dusk' }).click();
    await page.getByRole('button', { name: 'Delete kit' }).click();
    await toast(page, 'Dusk deleted');
    await expect(page.getByRole('listitem').filter({ hasText: 'Dusk' })).toHaveCount(0);
    await w.settle();
    w.assertClean();
    await page.context().close();
  });
});

test.describe('hashtags', () => {
  test('default from the name, custom tag, always-hashtags, persistence', async ({ browser }) => {
    const page = await newPage(browser, ownerState);
    const w = new Watcher(page);
    await openTab(page, w, 'hashtags', 'Hashtags');
    const business = page.getByLabel('Business hashtag');
    await expect(business).toHaveValue('');
    await expect(page.getByText(/Leave it empty to use #/)).toBeVisible();
    await business.fill('bad tag!');
    await expect(page.locator('p[role="alert"]')).toContainText('letters, numbers and _ only');
    await expect(page.getByRole('button', { name: 'Save hashtags' })).toBeDisabled();
    await business.fill('#DawnBakers');
    const always = page.getByLabel('Always include');
    await always.fill('SpringMenu');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await always.fill('springmenu');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.locator('p[role="alert"]')).toContainText('already in the list');
    await always.fill('LeedsEats, NewLoaf');
    await always.press('Enter');
    await page.getByRole('button', { name: 'Move #NewLoaf earlier' }).click();
    await page.getByRole('button', { name: 'Move #NewLoaf earlier' }).click();
    await page.getByRole('button', { name: 'Remove #LeedsEats' }).click();
    await page.getByRole('button', { name: 'Save hashtags' }).click();
    await toast(page, 'Hashtags saved');
    const saved = await db.businessHashtagSettings.findFirstOrThrow({
      where: { businessId: owner.businessId },
    });
    expect(saved.primaryHashtag).toBe('DawnBakers');
    expect(saved.alwaysHashtags).toEqual(['NewLoaf', 'SpringMenu']);
    await page.reload();
    await expect(page.getByLabel('Business hashtag')).toHaveValue('DawnBakers');
    await expect(page.getByText('#NewLoaf')).toBeVisible();
    // Back to the default.
    await page.getByRole('button', { name: 'Use the default' }).click();
    await page.getByRole('button', { name: 'Save hashtags' }).click();
    await toast(page, 'Hashtags saved');
    w.assertClean();
    await page.context().close();
  });
});

test.describe('image library', () => {
  test('empty library: the hint, no stock key, upload rejects bad files', async ({ browser }) => {
    await db.imageLibraryItem.deleteMany({ where: { businessId: owner.businessId } });
    const page = await newPage(browser, ownerState);
    const w = new Watcher(page, [
      { method: 'POST', url: /\/api\/studio\/image-library$/, status: 400 },
    ]);
    await openTab(page, w, 'images', 'Image library');
    await expect(page.getByText('Your image library is empty')).toBeVisible();
    // Over 15 MB: refused in the browser, nothing is sent.
    await page.getByLabel('Image file to upload').setInputFiles({
      name: 'big.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(15 * 1024 * 1024 + 1),
    });
    await toast(page, 'Image is larger than 15 MB');
    // Not an image: the server says so in plain words.
    await page.getByLabel('Image file to upload').setInputFiles({
      name: 'notes.png',
      mimeType: 'image/png',
      buffer: Buffer.from('not an image at all'),
    });
    await toast(page, /not a supported image/i);
    await expect(page.getByText('Your image library is empty')).toBeVisible();
    w.assertClean();
    await page.context().close();
  });

  test('upload, duplicate upload, search, delete', async ({ browser }) => {
    await db.imageLibraryItem.deleteMany({ where: { businessId: owner.businessId } });
    const page = await newPage(browser, ownerState);
    const w = new Watcher(page);
    await openTab(page, w, 'images', 'Image library');
    const bytes = await pngBytes(11);
    const file = { name: 'loaf.png', mimeType: 'image/png', buffer: bytes };
    await page.getByLabel('Image file to upload').setInputFiles(file);
    await toast(page, 'Image added');
    await expect(
      page.getByRole('list', { name: 'Image library' }).getByRole('listitem'),
    ).toHaveCount(1);
    await page.getByLabel('Image file to upload').setInputFiles(file);
    await toast(page, 'That image is already in your library');
    await expect(
      page.getByRole('list', { name: 'Image library' }).getByRole('listitem'),
    ).toHaveCount(1);
    // Thumbnails render (the preview URL answers locally with an image).
    await expect
      .poll(() =>
        page
          .locator('ul[aria-label="Image library"] img')
          .first()
          .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
      )
      .toBe(true);
    const row = await db.imageLibraryItem.findFirstOrThrow({
      where: { businessId: owner.businessId },
    });
    expect(row.source).toBe('UPLOAD');

    // Delete: cancel keeps it, confirm removes it from the list and the database.
    await page
      .getByRole('button', { name: /Delete image/ })
      .first()
      .click({ force: true });
    await page.getByRole('button', { name: 'Keep it' }).click();
    await expect(
      page.getByRole('list', { name: 'Image library' }).getByRole('listitem'),
    ).toHaveCount(1);
    await page
      .getByRole('button', { name: /Delete image/ })
      .first()
      .click({ force: true });
    await page.getByRole('button', { name: 'Delete image', exact: true }).click();
    await toast(page, 'Image deleted');
    await expect(page.getByText('Your image library is empty')).toBeVisible();
    expect(await db.imageLibraryItem.count({ where: { businessId: owner.businessId } })).toBe(0);
    w.assertClean();
    await page.context().close();
  });

  test('sources, thumbnails, filters, paging and semantic search', async ({ browser }) => {
    const seeds = [
      {
        source: 'SCRAPED' as const,
        altText: 'Golden sourdough loaf',
        tags: ['bread'],
        embedded: true,
      },
      {
        source: 'STOCK' as const,
        altText: 'Cosy bakery interior',
        tags: ['bakery'],
        hotlinked: true,
        embedded: true,
      },
      {
        source: 'GENERATED' as const,
        altText: 'Flat lay of pastries',
        tags: ['pastry'],
        embedded: true,
      },
      ...Array.from({ length: 31 }, (_, i) => ({
        source: 'UPLOAD' as const,
        altText: `Filler ${i}`,
        tags: ['filler'],
        createdAt: new Date(Date.now() - 10_000 - i * 1_000),
      })),
    ];
    await seedImages(db, owner, seeds);
    const page = await newPage(browser, ownerState);
    const w = new Watcher(page);
    await openTab(page, w, 'images', 'Image library');
    const grid = page.getByRole('list', { name: 'Image library' });
    await expect(grid.getByRole('listitem')).toHaveCount(30);
    await expect
      .poll(() =>
        grid
          .locator('img')
          .evaluateAll((imgs) =>
            (imgs as HTMLImageElement[]).every((i) => i.complete && i.naturalWidth > 0),
          ),
      )
      .toBe(true);
    // Paging: 34 images, 30 a page.
    await expect(page.getByRole('button', { name: 'Newer' })).toBeDisabled();
    await page.getByRole('button', { name: 'Older' }).click();
    await expect(grid.getByRole('listitem')).toHaveCount(4);
    await expect(page.getByRole('button', { name: 'Older' })).toBeDisabled();
    await page.getByRole('button', { name: 'Newer' }).click();

    // Source and tag filters, and the filtered empty state.
    await page.getByLabel('Source').selectOption({ label: 'Stock' });
    await expect(grid.getByRole('listitem')).toHaveCount(1);
    await page.getByLabel('Source').selectOption({ label: 'All sources' });
    await page.getByLabel('Tag', { exact: true }).fill('pastry');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(grid.getByRole('listitem')).toHaveCount(1);
    await page.getByLabel('Tag', { exact: true }).fill('nothing-here');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText('No images match')).toBeVisible();
    await page.getByLabel('Tag', { exact: true }).fill('');
    await page.getByRole('button', { name: 'Apply' }).click();

    // Semantic search ranks the matching picture first, shows the match, and clears.
    await page
      .getByRole('searchbox')
      .or(page.getByLabel('Search images by meaning'))
      .first()
      .fill('golden sourdough loaf');
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByText(/image(s)? like/)).toBeVisible();
    const results = page.getByRole('list', { name: 'Search results' });
    await expect(results.getByRole('listitem').first()).toContainText('match');
    await expect(results.getByRole('listitem').first().locator('img')).toHaveAttribute(
      'alt',
      'Golden sourdough loaf',
    );
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(grid).toBeVisible();
    w.assertClean();
    await page.context().close();
  });

  test('refresh stock explains when no stock provider is set up', async ({ browser }) => {
    test.skip(!queueOk, 'the refresh job needs Redis 5+; the message is checked in CI');
    const page = await newPage(browser, ownerState);
    const w = new Watcher(page, [{ method: 'POST', url: /image-library\/refresh$/, status: 501 }]);
    await openTab(page, w, 'images', 'Image library');
    await page.getByRole('button', { name: 'Refresh stock' }).click();
    await expect(page.locator('[data-sonner-toast]').first()).toContainText(/stock/i);
    await expect(page.locator('[data-sonner-toast]').first()).not.toContainText('PEXELS_API_KEY');
    await expect(page.locator('[data-sonner-toast]').first()).not.toContainText(
      'Searching stock libraries',
    );
    w.assertClean();
    await page.context().close();
  });

  test('generate: validation on Plus and a plan lock on Basic', async ({ browser }) => {
    // Plus: the form validates and can be cancelled. It is never submitted here: that would call
    // the real image provider with a placeholder key, and the 401 would hold the provider for
    // every later spec (generation success and failure are covered by vitest).
    const page = await newPage(browser, ownerState);
    const w = new Watcher(page);
    await openTab(page, w, 'images', 'Image library');
    await page.getByRole('button', { name: 'Generate', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const go = dialog.getByRole('button', { name: 'Generate', exact: true });
    await expect(go).toBeDisabled();
    await dialog.getByLabel('Prompt').fill('hi');
    await expect(go).toBeDisabled();
    await dialog.getByLabel('Prompt').fill('A loaf on a wooden counter at dawn');
    await dialog.getByLabel('Shape').selectOption('9:16');
    await expect(go).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(
      await db.imageLibraryItem.count({
        where: {
          businessId: owner.businessId,
          source: 'GENERATED',
          generatedFromPrompt: { not: null },
        },
      }),
    ).toBe(0);
    await page.context().close();

    // Basic: a plan lock beside the button and the upgrade dialog when it is used.
    const basicPage = await newPage(browser, basicState);
    const bw = new Watcher(basicPage, [
      { method: 'POST', url: /image-library\/generate$/, status: 403 },
    ]);
    await openTab(basicPage, bw, 'images', 'Image library');
    await basicPage.getByRole('button', { name: 'Generate', exact: true }).click();
    await basicPage.getByRole('dialog').getByLabel('Prompt').fill('A loaf on a wooden counter');
    await basicPage
      .getByRole('dialog')
      .getByRole('button', { name: 'Generate', exact: true })
      .click();
    await expect(
      basicPage
        .getByRole('dialog')
        .filter({ hasText: /plan|upgrade/i })
        .first(),
    ).toBeVisible();
    bw.assertClean();
    await basicPage.context().close();
  });
});

test.describe('what Studio has learned', () => {
  test('lists, edits, pins, switches off and forgets a signal', async ({ browser }) => {
    await db.styleMemory.create({
      data: {
        organisationId: owner.organisationId,
        businessId: owner.businessId,
        signalType: 'SHOT_PACE',
        value: { summary: 'Fast cuts, three shots under 2 seconds' },
        weight: 0.7,
        evidenceCount: 9,
        reason: 'Approved 7 of 9 fast-cut videos',
        lastEvidenceAt: new Date(),
      },
    });
    const page = await newPage(browser, ownerState);
    const w = new Watcher(page);
    await openTab(page, w, 'learned', 'What Studio has learned');
    await expect(page.getByRole('list', { name: 'What Studio has learned' })).toContainText(
      'Shot pace',
    );
    await expect(page.getByText(/Approved 7 of 9/)).toBeVisible();
    await page.getByRole('button', { name: 'Pin Shot pace' }).click();
    await toast(page, 'Shot pace pinned');
    await page.getByRole('button', { name: 'Unpin Shot pace' }).click();
    await toast(page, 'Shot pace unpinned');
    await page.getByRole('button', { name: 'Edit Shot pace' }).click();
    await page.getByLabel('New value for Shot pace').fill('Slow and steady');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await toast(page, 'Shot pace updated and pinned');
    await page.getByRole('button', { name: 'Delete Shot pace' }).click();
    await toast(page, 'Shot pace forgotten');
    await expect(page.getByText('Nothing learned yet')).toBeVisible();
    w.assertClean();
    await page.context().close();
  });
});

test.describe('permissions', () => {
  test('a viewer can read the business screens but is not offered write controls', async ({
    browser,
  }) => {
    const page = await newPage(browser, viewerState);
    const w = new Watcher(page);
    await openTab(page, w, 'profile', 'Profile');
    await expect(page.getByLabel('Industry')).toBeVisible();
    await expect(page.getByLabel('Industry')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save profile' })).toBeDisabled();
    await openTab(page, w, 'scan', 'Website scan');
    await expect(page.getByLabel('Website address')).toBeDisabled();
    await openTab(page, w, 'brand', 'Brand kits');
    await expect(page.getByRole('button', { name: 'New brand kit' })).toBeDisabled();
    await openTab(page, w, 'images', 'Image library');
    await expect(page.getByRole('button', { name: 'Upload', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Refresh stock' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Add a business' })).toHaveCount(0);
    await w.settle();
    w.assertClean();
    await page.context().close();
  });
});

test.describe('connections', () => {
  test('lists platforms, explains the one that is not set up, connects and disconnects', async ({
    browser,
  }) => {
    const names = {
      active: `@dawn_bakers_${run}`,
      stale: `Dawn Bakers YouTube ${run}`,
      orgWide: `Dawn Bakers LinkedIn ${run}`,
    };
    const other = await db.business.create({
      data: {
        organisationId: owner.organisationId,
        name: `QA Other ${run}`,
        createdByUserId: owner.userId,
      },
    });
    const base = {
      organisationId: owner.organisationId,
      encryptedAccessToken: 'qa-placeholder',
      scopes: ['publish'],
      connectedByUserId: owner.userId,
    };
    await db.platformConnection.createMany({
      data: [
        {
          ...base,
          businessId: owner.businessId,
          platform: 'tiktok',
          platformAccountId: `tt-${run}`,
          platformAccountName: names.active,
          state: 'active',
        },
        {
          ...base,
          businessId: owner.businessId,
          platform: 'youtube',
          platformAccountId: `yt-${run}`,
          platformAccountName: names.stale,
          state: 'needs_reconnect',
        },
        {
          ...base,
          businessId: other.id,
          platform: 'x',
          platformAccountId: `x-${run}`,
          platformAccountName: 'Other business X',
          state: 'active',
        },
        {
          ...base,
          businessId: null,
          platform: 'linkedin',
          platformAccountId: `li-${run}`,
          platformAccountName: names.orgWide,
          state: 'active',
        },
      ],
    });
    const page = await newPage(browser, ownerState);
    await page.route(/www\.tiktok\.com\/v2\/auth|accounts\.google\.com/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<h1>Platform consent screen</h1>',
      }),
    );
    const w = new Watcher(page);
    w.label('/connections');
    await page.goto('/connections');
    await w.settle();
    // This business's accounts, an organisation-wide one, but not another business's.
    await expect(page.getByText(names.active, { exact: true })).toBeVisible();
    await expect(page.getByText(names.orgWide)).toBeVisible();
    await expect(page.getByText('Other business X')).toHaveCount(0);
    await expect(page.getByText('Needs reconnecting')).toBeVisible();
    await expect(page.getByText(/Access expired or was revoked/)).toBeVisible();
    // X is not connected for this business, and it is set up (a Connect button).
    await expect(page.getByRole('button', { name: 'Connect X' })).toBeVisible();

    // Connect TikTok: the browser goes to the platform's consent screen with our state.
    const authorize = page.waitForRequest(/www\.tiktok\.com\/v2\/auth\/authorize/);
    await page.getByRole('button', { name: 'Add another TikTok account' }).click();
    const url = new URL((await authorize).url());
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('redirect_uri')).toMatch(/oauth-callback$/);
    await expect(page.getByText('Platform consent screen')).toBeVisible();
    await page.goBack();

    // Reconnect the stale YouTube account goes to Google.
    const google = page.waitForRequest(/accounts\.google\.com/);
    await page.getByRole('button', { name: 'Reconnect' }).click();
    expect((await google).url()).toContain('access_type=offline');
    await page.goto('/connections');

    // Disconnect: cancel keeps it; confirm wipes the tokens and removes the row.
    await page.getByRole('button', { name: `Disconnect ${names.active}` }).click();
    await page.getByRole('button', { name: 'Keep it' }).click();
    await expect(page.getByText(names.active, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: `Disconnect ${names.active}` }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Disconnect', exact: true }).click();
    await toast(page, `${names.active} disconnected`);
    await expect(page.getByText(names.active, { exact: true })).toHaveCount(0);
    const gone = await db.platformConnection.findFirstOrThrow({
      where: { platformAccountId: `tt-${run}` },
    });
    expect(gone).toMatchObject({ state: 'revoked', encryptedAccessToken: '' });
    w.assertClean();
    await page.context().close();
    await db.platformConnection.deleteMany({ where: { organisationId: owner.organisationId } });
    await db.business.delete({ where: { id: other.id } });
  });

  test('a platform without settings is explained, not offered; Instagram and Facebook too', async ({
    browser,
  }) => {
    const page = await newPage(browser, ownerState);
    const w = new Watcher(page);
    w.label('/connections not configured');
    await page.goto('/connections');
    await w.settle();
    await expect(page.getByText(/LinkedIn is not available yet/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Connect LinkedIn/ })).toHaveCount(0);
    await expect(
      page.getByText(/Instagram and Facebook are not available yet/).first(),
    ).toBeVisible();
    w.assertClean();
    await page.context().close();
  });

  test('a stale account of a platform without settings has no Reconnect that cannot work', async ({
    browser,
  }) => {
    await db.platformConnection.create({
      data: {
        organisationId: owner.organisationId,
        businessId: owner.businessId,
        platform: 'linkedin',
        platformAccountId: `li-stale-${run}`,
        platformAccountName: `Stale LinkedIn ${run}`,
        encryptedAccessToken: 'qa-placeholder',
        scopes: ['publish'],
        state: 'needs_reconnect',
        connectedByUserId: owner.userId,
      },
    });
    const page = await newPage(browser, ownerState);
    await page.goto('/connections');
    await expect(page.getByText(`Stale LinkedIn ${run}`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reconnect' })).toHaveCount(0);
    await page.context().close();
    await db.platformConnection.deleteMany({ where: { organisationId: owner.organisationId } });
  });

  test('callback results: connected notice, declined, unknown state, wrong state', async ({
    browser,
  }) => {
    const page = await newPage(browser, ownerState);
    const w = new Watcher(page);
    w.label('/connections callback');
    await page.goto('/connections?connected=tiktok');
    await expect(page.getByRole('status').filter({ hasText: 'TikTok is connected' })).toBeVisible();
    await expect(page).toHaveURL(/\/connections$/);
    await page.goto('/connections?connection_error=validation_error');
    await expect(page.getByRole('alert').filter({ hasText: /did not grant access/ })).toBeVisible();
    await page.goto('/connections?connection_error=meta_no_accounts');
    await expect(page.getByRole('alert').filter({ hasText: /at least one Page/ })).toBeVisible();
    await page.goto('/connections?connection_error=something_new');
    await expect(page.getByRole('alert').filter({ hasText: /something_new/ })).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(notice(page)).toHaveCount(0);

    // The platform redirects back with an unknown or used state (a stale tab, a double click):
    // the browser lands on Connections with an explanation, never on a raw JSON page.
    const res = await page.goto(
      '/api/studio/platform-connections/oauth-callback?code=x&state=nope',
    );
    expect(res?.status()).toBeLessThan(400);
    await expect(page).toHaveURL(/\/connections/);
    await expect(notice(page)).toBeVisible();
    await page.context().close();
  });

  test('a viewer cannot connect or disconnect', async ({ browser }) => {
    await db.platformConnection.create({
      data: {
        organisationId: owner.organisationId,
        businessId: owner.businessId,
        platform: 'tiktok',
        platformAccountId: `tt-v-${run}`,
        platformAccountName: `Viewer TikTok ${run}`,
        encryptedAccessToken: 'qa-placeholder',
        scopes: ['publish'],
        state: 'active',
        connectedByUserId: owner.userId,
      },
    });
    const page = await newPage(browser, viewerState);
    const w = new Watcher(page);
    w.label('/connections viewer');
    await page.goto('/connections');
    await expect(page.getByText(`Viewer TikTok ${run}`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add another TikTok account' })).toBeDisabled();
    await expect(
      page.getByRole('button', { name: `Disconnect Viewer TikTok ${run}` }),
    ).toBeDisabled();
    w.assertClean();
    await page.context().close();
    await db.platformConnection.deleteMany({ where: { organisationId: owner.organisationId } });
  });
});

test.describe('layout: phone, dark, right to left', () => {
  const PAGES: Array<[string, string]> = [
    ['/business?tab=profile', 'Profile'],
    ['/business?tab=scan', 'Website scan'],
    ['/business?tab=brand', 'Brand kits'],
    ['/business?tab=hashtags', 'Hashtags'],
    ['/business?tab=images', 'Image library'],
    ['/business?tab=learned', 'What Studio has learned'],
  ];

  test('375 px: no horizontal overflow on any tab or on Connections', async ({ browser }) => {
    const page = await newPage(browser, ownerState, { width: 375 });
    const w = new Watcher(page);
    for (const [path] of [...PAGES, ['/connections', '']] as Array<[string, string]>) {
      w.label(path);
      await page.goto(path);
      await w.settle();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path} overflows by ${overflow}px`).toBeLessThanOrEqual(1);
      await shot(page, `phone-${path}`);
      await w.check();
    }
    w.assertClean();
    await page.context().close();
  });

  test('dark mode: every tab and Connections load cleanly', async ({ browser }) => {
    const page = await newPage(browser, ownerState, { dark: true });
    const w = new Watcher(page);
    for (const [path] of [...PAGES, ['/connections', '']] as Array<[string, string]>) {
      w.label(path);
      await page.goto(path);
      await w.settle();
      await w.check();
      await shot(page, `dark-${path}`);
    }
    w.assertClean();
    await page.context().close();
  });

  test('Arabic: right to left, every tab and Connections load cleanly', async ({ browser }) => {
    const page = await newPage(browser, ownerState, { locale: 'ar' });
    const w = new Watcher(page);
    for (const [path] of [...PAGES, ['/connections', '']] as Array<[string, string]>) {
      w.label(path);
      await page.goto(path);
      await w.settle();
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await shot(page, `rtl-${path}`);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path} overflows by ${overflow}px`).toBeLessThanOrEqual(1);
      await w.check();
    }
    w.assertClean();
    await page.context().close();
  });
});
