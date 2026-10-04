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
import { baseURL } from './pass2.support';

// Hydration (React error #418): the server renders the app shell and each page in ITS time zone,
// without the visitor's saved theme; the browser hydrates in the visitor's. Any text that differs
// between the two (a month heading, "Times are shown in your time zone: …", a theme icon) makes
// React throw #418 and re-render the page on the client. These pages are loaded with a browser
// time zone far from the server's (CI runs in UTC; Auckland is UTC+12/+13, Los Angeles UTC-7/-8)
// in English and in Arabic (right-to-left) with the dark theme, and must hydrate without errors.

const hasDb = Boolean(process.env.DATABASE_URL);
test.skip(!hasDb, 'DATABASE_URL is not set: the QA specs need the app’s database');
test.describe.configure({ mode: 'serial' });

const SHELL_PAGES = ['/projects', '/templates', '/calendar', '/library'];
const TIME_ZONES = ['Pacific/Auckland', 'America/Los_Angeles'];
const LOCALES = ['en-GB', 'ar'] as const;
const HYDRATION = /hydrat|Minified React error #(418|419|421|422|423|425)\b/i;

let db: Db;
let world: World;
let ownerState: Awaited<ReturnType<BrowserContext['storageState']>>;

test.beforeAll(async ({ browser, playwright }) => {
  test.setTimeout(180_000);
  db = newDb();
  const request = await playwright.request.newContext({ baseURL });
  const ownerId = await createUser(request, db, baseURL, emailFor('hydration'), 'QA owner');
  world = await seedWorld(db, ownerId);
  await addMember(db, world.orgId, ownerId, 'owner');
  await request.dispose();
  // Sign in once (sign-in is rate limited) and reuse the cookies in every context below.
  const page = await signedInPage(browser, baseURL, emailFor('hydration'));
  ownerState = await page.context().storageState();
  await page.context().close();
});

test.afterAll(async () => {
  await cleanWorld(db, world);
  const users = await db.user.findMany({
    where: { email: emailFor('hydration') },
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

/** A signed-in page in `timezoneId`, with the locale cookie, saved dark theme and business. */
async function visitorPage(
  browser: Browser,
  timezoneId: string,
  locale: (typeof LOCALES)[number],
): Promise<Page> {
  const host = new URL(baseURL).hostname;
  const context = await browser.newContext({
    baseURL,
    locale,
    timezoneId,
    viewport: { width: 375, height: 812 },
    storageState: {
      ...ownerState,
      cookies: [
        ...ownerState.cookies.filter((c) => c.name !== 'studio.locale'),
        {
          name: 'studio.locale',
          value: locale,
          domain: host,
          path: '/',
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: 'Lax',
        },
      ],
    },
  });
  const businessId = world.businessId;
  await context.addInitScript((id) => {
    window.localStorage.setItem('theme', 'dark');
    window.localStorage.setItem('studio.businessId', id);
  }, businessId);
  return context.newPage();
}

for (const timezoneId of TIME_ZONES) {
  for (const locale of LOCALES) {
    test(`shell pages hydrate without a mismatch in ${timezoneId}, ${locale}, dark`, async ({
      browser,
    }) => {
      test.setTimeout(180_000);
      const page = await visitorPage(browser, timezoneId, locale);
      const errors: string[] = [];
      let current = '';
      page.on('pageerror', (e) => errors.push(`${current}: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error' && HYDRATION.test(m.text()))
          errors.push(`${current}: ${m.text().slice(0, 300)}`);
      });
      // The browser really is in another zone than the one it is told about.
      expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(
        timezoneId,
      );
      for (const path of SHELL_PAGES) {
        current = path;
        await page.goto(path);
        await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
        await expect(page.locator('html')).toHaveClass(/dark/);
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
      }
      // The calendar shows the visitor's zone once hydrated.
      current = '/calendar (time zone line)';
      await page.goto('/calendar');
      await expect(page.getByText(timezoneId).first()).toBeVisible();
      expect(errors, errors.join('\n')).toEqual([]);
      await page.context().close();
    });
  }
}
