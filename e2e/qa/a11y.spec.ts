import { appendFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
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
import { baseURL, PUBLIC_PAGES, staffPage, enableDarkTheme, WORKSPACE_PAGES } from './pass2.support';

// 20.31 (QA pass 2) — accessibility: axe-core (WCAG 2.0 / 2.1 A and AA rules) over every main
// screen, signed out and signed in, in the light and the dark theme. Serious and critical
// violations fail the test; minor and moderate ones are attached to the report as JSON.

const hasDb = Boolean(process.env.DATABASE_URL);
test.skip(!hasDb, 'DATABASE_URL is not set: the QA specs need the app’s database');

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const BLOCKING = new Set(['serious', 'critical']);

interface Finding {
  page: string;
  theme: string;
  rule: string;
  impact: string;
  help: string;
  nodes: string[];
}

const findings: Finding[] = [];

/** Run axe on the page as it is now; record every violation, return only the blocking ones. */
async function scan(page: Page, name: string, theme: 'light' | 'dark'): Promise<Finding[]> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const mapped = results.violations.map<Finding>((v) => ({
    page: name,
    theme,
    rule: v.id,
    impact: v.impact ?? 'minor',
    help: v.help,
    nodes: v.nodes.slice(0, 4).map((n) => `${n.target.join(' ')} :: ${n.failureSummary ?? ''}`),
  }));
  findings.push(...mapped);
  // Optional: one JSON line per finding, for triage (the worker restarts after a failed test).
  if (process.env.E2E_A11Y_OUT)
    for (const f of mapped) appendFileSync(process.env.E2E_A11Y_OUT, `${JSON.stringify(f)}\n`);
  return mapped.filter((f) => BLOCKING.has(f.impact));
}

async function visit(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  // Skeletons and toasts settle; axe must see the real screen, not the loading state.
  await expect(page.locator('main, [role="main"], body').first()).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 });
}

let db: Db;
let world: World;
let owner: Page;
let staff: Page | undefined;

test.beforeAll(async ({ browser, playwright }) => {
  test.setTimeout(300_000);
  db = newDb();
  const request = await playwright.request.newContext({ baseURL });
  const ownerId = await createUser(request, db, baseURL, emailFor('owner'), 'QA owner');
  world = await seedWorld(db, ownerId);
  await addMember(db, world.orgId, ownerId, 'owner');
  owner = await signedInPage(browser, baseURL, emailFor('owner'));
  staff = (await staffPage(browser, request, db)).page;
  await request.dispose();
});

test.afterAll(async () => {
  await owner?.context().close();
  await staff?.context().close();
  await cleanWorld(db, world);
  const users = await db.user.findMany({
    where: { OR: [{ email: emailFor('owner') }, { email: { startsWith: 'qa-p2-staff-' } }] },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  await db.session.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
  await db.twoFactor?.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
  await db.account.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
  if (world)
    await db.organization.deleteMany({ where: { id: { in: [world.orgId, world.emptyOrgId] } } });
  await db?.$disconnect();
  if (findings.length) {
    process.stdout.write(`AXE FINDINGS (all impacts)\n${JSON.stringify(findings, null, 2)}\n`);
  }
});

for (const theme of ['light', 'dark'] as const) {
  test.describe(`axe, ${theme} theme`, () => {
    test(`public pages have no serious or critical violations`, async ({ browser }) => {
      test.setTimeout(240_000);
      const context = await browser.newContext({ baseURL, locale: 'en-GB' });
      const page = await context.newPage();
      if (theme === 'dark') await enableDarkTheme(page);
      const blocking: Finding[] = [];
      for (const path of PUBLIC_PAGES) {
        await visit(page, path);
        blocking.push(...(await scan(page, path, theme)));
      }
      await context.close();
      expect(blocking).toEqual([]);
    });

    test(`signed-in pages have no serious or critical violations`, async () => {
      test.setTimeout(420_000);
      if (theme === 'dark') await enableDarkTheme(owner);
      const blocking: Finding[] = [];
      const paths = [
        ...WORKSPACE_PAGES,
        `/projects/${world.projects.review}`,
        `/projects/${world.projects.approved}`,
        `/projects/${world.projects.qfailed}`,
        `/analytics/publications/${world.publications.live}`,
      ];
      for (const path of paths) {
        await visit(owner, path);
        blocking.push(...(await scan(owner, path, theme)));
      }
      expect(blocking).toEqual([]);
    });

    test(`the Admin Centre tabs have no serious or critical violations`, async () => {
      test.setTimeout(300_000);
      const page = staff as Page;
      if (theme === 'dark') await enableDarkTheme(page);
      await visit(page, '/admin');
      const names = (await page.getByRole('tab').allInnerTexts()).map((n) => n.trim());
      expect(names.length).toBeGreaterThan(3);
      const blocking: Finding[] = [];
      for (const name of names) {
        await page.getByRole('tab', { name, exact: true }).click();
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
        blocking.push(...(await scan(page, `/admin: ${name}`, theme)));
      }
      expect(blocking).toEqual([]);
    });
  });
}
