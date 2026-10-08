import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';

// QA 5: calendar and analytics through the real UI, with Prisma fixtures, a fixed client clock
// (page.clock) and per-context time zones. Needs DATABASE_URL and a running app, like
// e2e/sweep.spec.ts. Platform APIs are never called: publications are seeded into the database.
// NOT YET RUN LOCALLY (the production build ran out of memory on the QA machine); CI runs it.

const hasDb = Boolean(process.env.DATABASE_URL);
const run = randomUUID().slice(0, 8);
const email = `qa5-${run}@example.test`;
const password = `Qa5-${randomUUID()}`;
const DAY_MS = 86_400_000;
const NOW = new Date('2026-10-01T09:00:00Z');
// 24.2: a calendar post is a button that opens the post panel.
const POST = 'button[aria-haspopup="dialog"]';

test.skip(!hasDb, 'DATABASE_URL is not set: needs the app’s database');
test.describe.configure({ mode: 'serial' });

let db: PrismaClient;
let organisationId = '';
let businessId = '';
let userId = '';
let storageState = '';
let ipCounter = 0;

// Better Auth rate-limits per client IP (x-real-ip when no proxy is trusted) and every spec runs
// from 127.0.0.1, so each context claims its own address instead of sharing the sweep's bucket.
function uniqueIp(): string {
  ipCounter += 1;
  const base = Number.parseInt(run.slice(0, 4), 16) % 200;
  return `10.${50 + (base % 150)}.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

interface PageOptions {
  timezoneId?: string;
  now?: Date;
  width?: number;
  locale?: string;
  dark?: boolean;
}

async function newPage(browser: Browser, opts: PageOptions = {}): Promise<Page> {
  const context = await browser.newContext({
    storageState,
    timezoneId: opts.timezoneId ?? 'Europe/London',
    locale: opts.locale ?? 'en-GB',
    viewport: { width: opts.width ?? 1280, height: 900 },
    extraHTTPHeaders: { 'x-real-ip': uniqueIp() },
    colorScheme: opts.dark ? 'dark' : 'light',
  });
  const page = await context.newPage();
  if (opts.now) await page.clock.install({ time: opts.now });
  return page;
}

interface SeedPublication {
  platform?: string;
  state: 'SCHEDULED' | 'PUBLISHED';
  at: Date;
  name: string;
  views?: number;
}

async function seedPublication(data: SeedPublication): Promise<string> {
  const platform = data.platform ?? 'tiktok';
  const project = await db.videoProject.create({
    data: {
      organisationId,
      businessId,
      createdByUserId: userId,
      name: data.name,
      state: 'APPROVED',
      sourceType: 'BRIEF',
      targetFormats: [],
    },
  });
  const render = await db.videoRender.create({
    data: {
      projectId: project.id,
      scriptId: 'qa5',
      targetPlatform: platform,
      aspectRatio: '9:16',
      resolution: '1080x1920',
      durationSec: 20,
      fps: 30,
      bitrateKbps: 4000,
      s3Bucket: 'ci-renders',
      s3Key: `qa5/${randomUUID()}.mp4`,
      qualityCheckState: 'PASSED',
    },
  });
  const published = data.state === 'PUBLISHED';
  const publication = await db.videoPublication.create({
    data: {
      organisationId,
      projectId: project.id,
      renderId: render.id,
      platform,
      platformAccountId: 'qa5-account',
      state: data.state,
      scheduledFor: published ? null : data.at,
      publishedAt: published ? data.at : null,
      hashtags: [],
    },
  });
  if (!published) {
    await db.scheduledPublication.create({
      data: { publicationId: publication.id, scheduledFor: data.at, state: 'PENDING' },
    });
  }
  if (published && data.views !== undefined) {
    await db.videoAnalytic.create({
      data: {
        publicationId: publication.id,
        bucketAt: new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS),
        bucketSize: 'day',
        views: data.views,
        likes: Math.floor(data.views / 10),
      },
    });
  }
  return publication.id;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  db = new PrismaClient();
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'x-real-ip': uniqueIp() });
  await page.goto('/sign-up');
  await page.getByLabel('Your name').fill('QA5 Tester');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /sign up|create account/i }).click();
  await expect
    .poll(
      async () =>
        (await db.user.updateMany({ where: { email }, data: { emailVerified: true } })).count,
      { timeout: 15_000 },
    )
    .toBe(1);
  await page.goto('/sign-in');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 30_000 }),
    page.getByRole('button', { name: /sign in/i }).click(),
  ]);
  await page.goto('/welcome');
  await page.getByLabel('Organisation name').fill(`QA5 Bakery ${run}`);
  await page.getByLabel('Country').selectOption('GB');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.getByLabel('Business name').fill(`QA5 Sourdough ${run}`);
  await page.getByRole('button', { name: 'Add business' }).click();
  await expect(
    page.getByRole('heading', { name: 'Your brand in three clicks' }).first(),
  ).toBeVisible();
  storageState = test.info().outputPath('qa5-state.json');
  await page.context().storageState({ path: storageState });
  await page.close();
  const org = await db.organization.findFirstOrThrow({ where: { name: `QA5 Bakery ${run}` } });
  organisationId = org.id;
  businessId = (await db.business.findFirstOrThrow({ where: { organisationId } })).id;
  userId = (await db.user.findFirstOrThrow({ where: { email } })).id;
});

test.afterAll(async () => {
  await db?.$disconnect();
});

test.describe('calendar', () => {
  test('empty month: 35 day cells in October 2026; phones show the empty text', async ({
    browser,
  }) => {
    const page = await newPage(browser, { now: NOW });
    await page.goto('/calendar');
    await expect(page.getByRole('heading', { name: /October 2026/ })).toBeVisible();
    await expect(page.locator('[data-day]')).toHaveCount(35);
    await page.close();
    const phone = await newPage(browser, { now: NOW, width: 375 });
    await phone.goto('/calendar');
    // The desktop grid has the same text but is hidden below md; only the agenda copy shows.
    await expect(
      phone.getByText('Nothing scheduled or published this month.').filter({ visible: true }),
    ).toHaveCount(1);
    await phone.close();
  });

  test('a post lands on the viewer’s local day (London vs Los Angeles) across the DST change', async ({
    browser,
  }) => {
    // 2026-10-24T23:30Z is 00:30 BST on the 25th in London, 16:30 PDT on the 24th in Los Angeles.
    await seedPublication({
      state: 'PUBLISHED',
      at: new Date('2026-10-24T23:30:00Z'),
      name: `Tz ${run}`,
    });
    // Clocks go back at 01:00Z on the 25th: 00:30Z and 01:30Z both read 01:30 in London.
    await seedPublication({
      state: 'PUBLISHED',
      at: new Date('2026-10-25T00:30:00Z'),
      name: `Dst BST ${run}`,
    });
    await seedPublication({
      state: 'PUBLISHED',
      at: new Date('2026-10-25T01:30:00Z'),
      name: `Dst GMT ${run}`,
    });
    const london = await newPage(browser, { now: NOW, timezoneId: 'Europe/London' });
    await london.goto('/calendar');
    const cell = london.locator('[data-day="2026-10-25"]');
    await expect(cell.locator(POST, { hasText: new RegExp(`Tz ${run}`) })).toBeVisible();
    await expect(cell.locator(POST)).toHaveCount(3);
    await expect(cell.getByText('01:30')).toHaveCount(2);
    await london.close();
    const la = await newPage(browser, { now: NOW, timezoneId: 'America/Los_Angeles' });
    await la.goto('/calendar');
    await expect(
      la.locator('[data-day="2026-10-24"]').locator(POST, { hasText: new RegExp(`Tz ${run}`) }),
    ).toBeVisible();
    await la.close();
  });

  test('requests the grid window in local time (DST aware) and navigates months', async ({
    browser,
  }) => {
    const page = await newPage(browser, { now: NOW, timezoneId: 'Europe/London' });
    const urls: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/studio/publications?')) urls.push(decodeURIComponent(r.url()));
    });
    await page.goto('/calendar');
    await expect(page.getByRole('heading', { name: /October 2026/ })).toBeVisible();
    // The grid runs Mon 28 Sep (BST) to Mon 2 Nov (GMT).
    await expect
      .poll(() =>
        urls.some(
          (u) =>
            u.includes('from=2026-09-27T23:00:00.000Z') &&
            u.includes('to=2026-11-02T00:00:00.000Z'),
        ),
      )
      .toBe(true);
    await page.getByRole('button', { name: 'Next month' }).click();
    await expect(page.getByRole('heading', { name: /November 2026/ })).toBeVisible();
    await page.getByRole('button', { name: 'Previous month' }).click();
    await page.getByRole('button', { name: 'Previous month' }).click();
    await expect(page.getByRole('heading', { name: /September 2026/ })).toBeVisible();
    await page.getByRole('button', { name: 'Today' }).click();
    await expect(page.getByRole('heading', { name: /October 2026/ })).toBeVisible();
    await page.close();
  });

  test('four posts on one day are all visible (regression: the fourth was hidden)', async ({
    browser,
  }) => {
    const platforms = ['tiktok', 'x', 'facebook', 'youtube_short'];
    for (const [i, hour] of ['08', '11', '14', '17'].entries()) {
      await seedPublication({
        state: 'PUBLISHED',
        platform: platforms[i],
        at: new Date(`2026-10-14T${hour}:00:00Z`),
        name: `Four ${hour} ${run}`,
      });
    }
    const page = await newPage(browser, { now: NOW });
    await page.goto('/calendar');
    const cell = page.locator('[data-day="2026-10-14"]');
    await expect(cell.locator(POST)).toHaveCount(4);
    await expect(cell.getByText(/\+\d+ more/)).toHaveCount(0);
    await page.close();
  });

  test('dragging a scheduled post keeps its local time across the DST change', async ({
    browser,
  }) => {
    // Fri 23 Oct 09:00 BST (08:00Z) moved to Mon 26 Oct: 09:00 GMT (09:00Z).
    const id = await seedPublication({
      state: 'SCHEDULED',
      at: new Date('2026-10-23T08:00:00Z'),
      name: `Drag ${run}`,
    });
    const page = await newPage(browser, { now: NOW, timezoneId: 'Europe/London' });
    await page.goto('/calendar');
    await expect(page.getByText(/Next 30 days/)).toBeVisible();
    const link = page
      .locator('[data-day="2026-10-23"]')
      .locator(POST, { hasText: new RegExp(`Drag ${run}`) });
    // Chromium's native drag does not deliver 'drop' under automation here (dragstart and
    // dragover fire and are accepted, then no drop), so replay the same three events with one
    // shared DataTransfer, exactly what the browser would send.
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    const target = page.locator('[data-day="2026-10-26"]');
    await link.dispatchEvent('dragstart', { dataTransfer: transfer });
    await target.dispatchEvent('dragover', { dataTransfer: transfer });
    await target.dispatchEvent('drop', { dataTransfer: transfer });
    await expect(page.getByText(/Moved to/).first()).toBeVisible();
    await expect
      .poll(async () =>
        (
          await db.videoPublication.findUniqueOrThrow({ where: { id } })
        ).scheduledFor?.toISOString(),
      )
      .toBe('2026-10-26T09:00:00.000Z');
    await page.close();
  });

  test('the move dialog rejects a time under a minute away', async ({ browser }) => {
    await seedPublication({
      state: 'SCHEDULED',
      at: new Date('2026-10-20T10:00:00Z'),
      name: `Move ${run}`,
    });
    const page = await newPage(browser, { now: NOW });
    await page.goto('/calendar');
    await page.getByRole('button', { name: `Move Move ${run} to another time` }).click();
    await page.getByLabel('New time').fill('2026-10-01T09:00');
    await page.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(page.getByText('Pick a time at least a minute from now.').first()).toBeVisible();
    await page.close();
  });

  test('error state offers Retry; published posts have no move button', async ({ browser }) => {
    const page = await newPage(browser, { now: NOW });
    await page.route('**/api/studio/publications?*', (route) =>
      route.fulfill({ status: 500, json: { ok: false, error: 'boom' } }),
    );
    await page.goto('/calendar');
    await expect(page.getByRole('alert').filter({ hasText: 'Couldn’t load this' })).toBeVisible();
    await page.unroute('**/api/studio/publications?*');
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.locator('[data-day]').first()).toBeVisible();
    await expect(page.getByRole('button', { name: `Move Tz ${run} to another time` })).toHaveCount(
      0,
    );
    await page.close();
  });

  test('phone, dark and Arabic (RTL) render without horizontal overflow', async ({ browser }) => {
    const page = await newPage(browser, { now: NOW, width: 375, dark: true, locale: 'ar' });
    await page.goto('/calendar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.close();
  });
});

test.describe('analytics', () => {
  test('seeded data: ranges change the totals and charts contain no NaN', async ({ browser }) => {
    const now = Date.now();
    // The calendar tests seeded "published" posts in the future; take them out of the analytics window.
    await db.videoPublication.updateMany({
      where: { organisationId, publishedAt: { gt: new Date(now) } },
      data: { state: 'CANCELLED' },
    });
    await seedPublication({
      state: 'PUBLISHED',
      platform: 'tiktok',
      at: new Date(now - 3 * DAY_MS),
      name: `An1 ${run}`,
      views: 1000,
    });
    await seedPublication({
      state: 'PUBLISHED',
      platform: 'youtube_short',
      at: new Date(now - 20 * DAY_MS),
      name: `An2 ${run}`,
      views: 500,
    });
    const page = await newPage(browser, { now: new Date(now) });
    await page.goto('/analytics');
    // 25.11: a one-sentence summary heads the page; the period lives in the URL.
    const summary = page.getByRole('region', { name: 'Summary' });
    await expect(summary).toContainText('from the last 30 days');
    await page.getByRole('radio', { name: '7 days' }).click();
    await expect(page).toHaveURL(/\/analytics\?days=7$/);
    await expect(summary).toContainText('Your 1 post from the last 7 days');
    await page.getByRole('radio', { name: '90 days' }).click();
    await expect(summary).toContainText('Your 2 posts from the last 90 days');
    await page.reload();
    await expect(page.getByRole('radio', { name: '90 days' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.getByRole('list', { name: 'Top publications' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('NaN');
    const badPaths = await page
      .locator('svg path')
      .evaluateAll((els) =>
        els.map((e) => e.getAttribute('d') ?? '').filter((d) => d.includes('NaN')),
      );
    expect(badPaths).toEqual([]);
    await page.close();
  });

  test('a failed section shows an error with Retry while the others stay up', async ({
    browser,
  }) => {
    const page = await newPage(browser);
    await page.route('**/api/studio/analytics/leaderboard*', (route) =>
      route.fulfill({ status: 500, json: { ok: false, error: 'boom' } }),
    );
    await page.goto('/analytics');
    await expect(page.getByRole('alert').filter({ hasText: 'Couldn’t load this' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Summary' })).toBeVisible();
    await page.close();
  });
});
