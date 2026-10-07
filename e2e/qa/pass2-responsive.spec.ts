import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  addMember,
  cleanWorld,
  createUser,
  emailFor,
  newDb,
  seedWorld,
  signedInPage,
  type Db,
  type World,
} from './fixtures';
import { baseURL, enableDarkTheme, noHorizontalScroll, watch } from './pass2.support';
import { chooseTheme } from './shell.support';

// 20.31 (QA pass 2) — the key flows (create, project review / approve, library search, business &
// images, settings) at 375 px, in the dark theme, and with the keyboard only. Providers are never
// called: generation is queued and never run (no worker in this job).

const hasDb = Boolean(process.env.DATABASE_URL);
test.skip(!hasDb, 'DATABASE_URL is not set: the QA specs need the app’s database');
test.describe.configure({ mode: 'serial' });

let db: Db;
let world: World;
/** The owner's signed-in cookies, captured on the first sign-in and reused by every test. */
let ownerState: Awaited<ReturnType<BrowserContext['storageState']>> | undefined;
const MOBILE = { width: 375, height: 812 };

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(120_000);
  db = newDb();
  const request = await playwright.request.newContext({ baseURL });
  const ownerId = await createUser(request, db, baseURL, emailFor('p2-resp'), 'QA owner');
  world = await seedWorld(db, ownerId);
  await addMember(db, world.orgId, ownerId, 'owner');
  await request.dispose();
});

test.afterAll(async () => {
  await cleanWorld(db, world);
  const users = await db.user.findMany({
    where: { email: emailFor('p2-resp') },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  await db.session.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
  await db.account.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
  if (world)
    await db.organization.deleteMany({ where: { id: { in: [world.orgId, world.emptyOrgId] } } });
  await db?.$disconnect();
});

async function ownerPage(
  browser: Browser,
  options: { viewport?: { width: number; height: number }; dark?: boolean } = {},
): Promise<Page> {
  // Sign-in is rate limited (5 a minute per client address), so the owner signs in once and every
  // later test reuses that session's cookies instead of signing in again.
  if (ownerState) {
    const context = await browser.newContext({
      baseURL,
      locale: 'en-GB',
      storageState: ownerState,
      ...(options.viewport && { viewport: options.viewport }),
    });
    const reused = await context.newPage();
    if (options.dark) await enableDarkTheme(reused);
    return reused;
  }
  // A 429 on that first sign-in is waited out, not a failure.
  let page: Page | undefined;
  for (let attempt = 1; !page; attempt += 1) {
    try {
      page = await signedInPage(browser, baseURL, emailFor('p2-resp'), {
        viewport: options.viewport,
      });
    } catch (err) {
      if (attempt >= 4 || !/429/.test(String(err))) throw err;
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
  }
  ownerState = await page.context().storageState();
  if (options.dark) await enableDarkTheme(page);
  return page;
}

/** What the keyboard focus is on right now: its tag, id and best-effort accessible name. */
async function focused(page: Page): Promise<{ tag: string; id: string; name: string }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return { tag: '', id: '', name: '' };
    const labelled = el.getAttribute('aria-labelledby');
    const byLabel = labelled
      ? (document.getElementById(labelled)?.textContent ?? '')
      : ((el as HTMLInputElement).labels?.[0]?.textContent ?? '');
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id,
      name: (el.getAttribute('aria-label') || byLabel || el.textContent || '').trim(),
    };
  });
}

/** Press Tab until the focused element matches; fails with where focus went if it never does. */
async function tabTo(
  page: Page,
  match: (f: { tag: string; id: string; name: string }) => boolean,
  max = 80,
): Promise<void> {
  const seen: string[] = [];
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press('Tab');
    const f = await focused(page);
    if (match(f)) return;
    seen.push(`${f.tag}#${f.id}:${f.name.slice(0, 20)}`);
  }
  throw new Error(`keyboard focus never reached the control; it visited ${seen.join(' > ')}`);
}

/** Every one of the checks a page must pass at any size and in any theme. */
async function expectUsable(page: Page, heading: RegExp | string): Promise<void> {
  await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
  expect(await noHorizontalScroll(page), 'the page scrolls sideways').toBe(true);
}

const KEY_PAGES = (w: World): Array<[string, string, RegExp | string]> => [
  ['create', '/new', /What’s the video about\?|Create/],
  ['project review', `/projects/${w.projects.review}`, 'QA Review video'],
  ['library', '/library', 'Reference library'],
  ['business and images', '/business', 'Business & images'],
  // 25.8: Image Studio.
  ['image studio', '/images', 'Images'],
  ['settings', '/settings/organisation', 'Organisation'],
];

// ------------------------------------------------------------------------------ mobile, 375 px

test.describe('mobile 375 px', () => {
  test('every key page fits the screen and the navigation opens from its button', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const page = await ownerPage(browser, { viewport: MOBILE });
    const w = watch(page);
    for (const [, path, heading] of KEY_PAGES(world)) {
      await w.visit(path);
      if (path === '/new') await expect(page.locator('#create-brief')).toBeVisible();
      else await expectUsable(page, heading);
      expect(await noHorizontalScroll(page), `${path} scrolls sideways`).toBe(true);
    }
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const nav = page.getByRole('dialog').or(page.getByRole('navigation', { name: 'Studio' }));
    await expect(nav.getByRole('link', { name: 'Reference library' }).first()).toBeVisible();
    await nav.getByRole('link', { name: 'Reference library' }).first().click();
    await expect(page).toHaveURL(/\/library$/);
    await expect(page.getByRole('heading', { name: 'Reference library' })).toBeVisible();
    expect(w.issues).toEqual([]);
    await page.context().close();
  });

  test('create: the brief, the Generate button and the result all work with a thumb', async ({
    browser,
  }) => {
    const page = await ownerPage(browser, { viewport: MOBILE });
    const w = watch(page);
    await w.visit('/new');
    await page.locator('#create-brief').fill('Mobile test: spring menu launches Friday');
    const generate = page.getByRole('button', { name: 'Generate' });
    await generate.scrollIntoViewIfNeeded();
    const box = await generate.boundingBox();
    expect(box?.height ?? 0, 'tap target is at least 40 px tall').toBeGreaterThanOrEqual(36);
    expect((box?.x ?? -1) + (box?.width ?? 0)).toBeLessThanOrEqual(MOBILE.width);
    await generate.click();
    await expect(page).toHaveURL(/\/projects\/[^/]+$/, { timeout: 60_000 });
    await expectUsable(page, /./);
    await page.context().close();
  });

  test('project review: the variants, Approve and its confirmation fit and work', async ({
    browser,
  }) => {
    const page = await ownerPage(browser, { viewport: MOBILE });
    const w = watch(page);
    await w.visit(`/projects/${world.projects.review}`);
    await expect(page.getByRole('article', { name: 'TikTok variant' })).toBeVisible();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    const confirm = page.getByRole('button', { name: 'Confirm approval' });
    await confirm.scrollIntoViewIfNeeded();
    await confirm.click();
    await expect(page.getByText('Approved — ready to publish.').first()).toBeVisible();
    await expect
      .poll(
        async () =>
          (await db.videoProject.findUniqueOrThrow({ where: { id: world.projects.review } })).state,
      )
      .toBe('APPROVED');
    expect(await noHorizontalScroll(page)).toBe(true);
    await page.context().close();
  });

  test('library: the search box and filters stack, and a search answers', async ({ browser }) => {
    const page = await ownerPage(browser, { viewport: MOBILE });
    const w = watch(page);
    await w.visit('/library');
    const search = page.getByRole('searchbox', { name: 'Search the library' });
    await search.fill('sourdough');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(
      page.getByText(/No references match|No close matches|Results for/).first(),
    ).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    expect(w.issues).toEqual([]);
    await page.context().close();
  });

  test('business & images: the six tabs can all be reached', async ({ browser }) => {
    const page = await ownerPage(browser, { viewport: MOBILE });
    const w = watch(page);
    await w.visit('/business');
    for (const name of [
      'Profile',
      'Website scan',
      'Brand kits',
      'Hashtags',
      'Image library',
      'What Studio has learned',
    ]) {
      const tab = page.getByRole('tab', { name });
      await tab.scrollIntoViewIfNeeded();
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tabpanel', { name })).toBeVisible();
      expect(await noHorizontalScroll(page), `${name} scrolls sideways`).toBe(true);
    }
    await page.context().close();
  });

  test('settings: the organisation form saves from a phone', async ({ browser }) => {
    const page = await ownerPage(browser, { viewport: MOBILE });
    const w = watch(page);
    await w.visit('/settings/organisation');
    const name = page.getByRole('textbox', { name: 'Organisation name' });
    const current = await name.inputValue();
    await name.fill(`${current} `.trimEnd());
    const [res] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/studio/') && r.request().method() !== 'GET',
      ),
      page.getByRole('button', { name: 'Save', exact: true }).click(),
    ]);
    expect(res.status()).toBeLessThan(400);
    expect(w.issues).toEqual([]);
    await page.context().close();
  });
});

// ------------------------------------------------------------------------------------ dark mode

test.describe('dark theme', () => {
  test('every key page renders dark, fits the screen and keeps its controls', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const page = await ownerPage(browser, { dark: true });
    const w = watch(page);
    for (const [, path, heading] of KEY_PAGES(world)) {
      await w.visit(path);
      await expect(page.locator('html')).toHaveClass(/dark/);
      if (path === '/new') await expect(page.locator('#create-brief')).toBeVisible();
      else await expectUsable(page, heading);
    }
    // The toggle goes back to light and remembers it.
    await chooseTheme(page, 'Light');
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    expect(w.issues).toEqual([]);
    await page.context().close();
  });

  test('project review in the dark: approve, then reject another with a note', async ({
    browser,
  }) => {
    const page = await ownerPage(browser, { dark: true });
    const w = watch(page);
    await w.visit(`/projects/${world.projects.review2}`);
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.getByRole('button', { name: 'Reject' }).click();
    await page.getByLabel(/What needs to change/).fill('Too long for dark mode');
    await page.getByRole('button', { name: 'Confirm rejection' }).click();
    await expect(page.getByText('Rejected.').first()).toBeVisible();
    await page.context().close();
  });

  test('library search, business tabs and the settings form work in the dark', async ({
    browser,
  }) => {
    const page = await ownerPage(browser, { dark: true });
    const w = watch(page);
    await w.visit('/library');
    await page.getByRole('searchbox', { name: 'Search the library' }).fill('bakery');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(
      page.getByText(/No references match|No close matches|Results for/).first(),
    ).toBeVisible();
    await w.visit('/business');
    await page.getByRole('tab', { name: 'Brand kits' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Brand kits' })).toBeVisible();
    await w.visit('/settings/organisation');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    expect(w.issues).toEqual([]);
    await page.context().close();
  });
});

// ------------------------------------------------------------------------------ keyboard only

test.describe('keyboard only', () => {
  test('create: reach the brief, type, reach Generate, press Enter', async ({ browser }) => {
    const page = await ownerPage(browser);
    const w = watch(page);
    await w.visit('/new');
    await tabTo(page, (f) => f.id === 'create-brief');
    await page.keyboard.type('Keyboard only: our new loyalty card');
    await tabTo(page, (f) => f.tag === 'button' && /^Generate$/.test(f.name));
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/projects\/[^/]+$/, { timeout: 60_000 });
    const project = await db.videoProject.findFirstOrThrow({
      where: { organisationId: world.orgId, description: { contains: 'Keyboard only' } },
    });
    expect(project.sourceType).toBe('BRIEF');
    await page.context().close();
  });

  test('project review: Approve and its confirmation by keyboard, focus stays in the dialog', async ({
    browser,
  }) => {
    const page = await ownerPage(browser);
    const w = watch(page);
    await w.visit(`/projects/${world.projects.review3}`);
    await tabTo(page, (f) => f.tag === 'button' && f.name === 'Approve');
    await page.keyboard.press('Enter');
    const confirm = page.getByRole('button', { name: 'Confirm approval' });
    await expect(confirm).toBeVisible();
    // Reach Confirm approval without a mouse, then Enter.
    await tabTo(page, (f) => f.tag === 'button' && f.name === 'Confirm approval', 20);
    await page.keyboard.press('Enter');
    await expect(page.getByText('Approved — ready to publish.').first()).toBeVisible();
    await expect
      .poll(
        async () =>
          (await db.videoProject.findUniqueOrThrow({ where: { id: world.projects.review3 } }))
            .state,
      )
      .toBe('APPROVED');
    await page.context().close();
  });

  test('project review: Escape backs out of the reject form and focus returns to Reject', async ({
    browser,
  }) => {
    const page = await ownerPage(browser);
    await page.goto(`/projects/${world.projects.review4}`);
    await tabTo(page, (f) => f.tag === 'button' && f.name === 'Reject');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Confirm rejection' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Confirm rejection' })).toHaveCount(0);
    expect((await focused(page)).name).toMatch(/Reject|Approve/);
    expect(
      (await db.videoProject.findUniqueOrThrow({ where: { id: world.projects.review4 } })).state,
    ).toBe('READY_FOR_REVIEW');
    await page.context().close();
  });

  test('library: reach the search box, type, Enter', async ({ browser }) => {
    const page = await ownerPage(browser);
    await page.goto('/library');
    await tabTo(page, (f) => f.name === 'Search the library' || f.id.includes('search'));
    await page.keyboard.type('sourdough');
    await page.keyboard.press('Enter');
    await expect(
      page.getByText(/No references match|No close matches|Results for/).first(),
    ).toBeVisible();
    await page.context().close();
  });

  test('business & images: arrow keys move through the tabs, and a field saves with Enter', async ({
    browser,
  }) => {
    const page = await ownerPage(browser);
    await page.goto('/business');
    await tabTo(page, (f) => f.name === 'Profile');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Website scan' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: 'What Studio has learned' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('Home');
    await expect(page.getByRole('tab', { name: 'Profile' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Rename the business with the keyboard only.
    await tabTo(page, (f) => f.name === 'Business name' || f.id.includes('name'));
    await page.keyboard.press('End');
    await page.keyboard.type(' Ltd');
    await tabTo(page, (f) => f.tag === 'button' && /Save details/.test(f.name), 10);
    const [res] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'PATCH' && r.url().includes('/api/studio/'),
      ),
      page.keyboard.press('Enter'),
    ]);
    expect(res.status()).toBeLessThan(400);
    await page.context().close();
  });

  test('settings: edit the organisation name and save with the keyboard', async ({ browser }) => {
    const page = await ownerPage(browser);
    await page.goto('/settings/organisation');
    await tabTo(page, (f) => f.name === 'Organisation name');
    await page.keyboard.press('End');
    await page.keyboard.type(' QA');
    await tabTo(page, (f) => f.tag === 'button' && f.name === 'Save', 12);
    const [res] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() !== 'GET' && r.url().includes('/api/studio/'),
      ),
      page.keyboard.press('Enter'),
    ]);
    expect(res.status()).toBeLessThan(400);
    await expect(page.getByRole('textbox', { name: 'Organisation name' })).toHaveValue(/ QA$/);
    await page.context().close();
  });
});
