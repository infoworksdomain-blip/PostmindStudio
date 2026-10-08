import { enableTwoFactor } from './qa/pass2.support';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Response } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { chooseLanguage, chooseTheme, openFeedback } from './qa/shell.support';

// Phase 20.10 — QA sweep: every page in the app shell, signed out, signed in without an
// organisation, with an organisation, and as platform staff (superadmin with 2FA). On each page it
// records what a user would call "an error": the error banners ("Couldn't load this", "Something
// went wrong", "You don't have permission"), error toasts, uncaught page errors, console errors
// from our code, and API calls answering 5xx (or 4xx other than the expected ones), then fails
// with the full list. Needs DATABASE_URL (the app's database) and a running app, like the happy
// path (playwright.config.ts). Screenshots of failing pages go to E2E_SWEEP_SHOTS (optional).

const hasDb = Boolean(process.env.DATABASE_URL);
const run = randomUUID().slice(0, 8);
const email = `sweep-${run}@example.test`;
const password = `Sweep-${randomUUID()}`;
const shotsDir = process.env.E2E_SWEEP_SHOTS;

const ERROR_TEXT = [
  /Couldn[’']t load this/,
  /Something went wrong/,
  /That didn[’']t go through/,
  /We couldn[’']t finish that on our side/,
  /You don[’']t have permission/,
  /Application error/,
  /This page hit a problem/,
  /Internal Server Error/,
];

interface Issue {
  page: string;
  kind: 'banner' | 'pageerror' | 'console' | 'http' | 'blank' | 'redirect';
  detail: string;
}

/** 4xx answers that are part of normal behaviour, keyed by a URL fragment. */
const EXPECTED_4XX: Array<{ url: RegExp; status: number[] }> = [
  // Signed-out and no-organisation probes: the UI reacts to these (redirect / wizard).
  { url: /\/api\/studio\/me\b/, status: [401, 403] },
  { url: /\/api\/auth\/get-session/, status: [401] },
  // No business profile yet (no website scan): Business and the library shelf show an empty state.
  { url: /\/business-profile$/, status: [404] },
  { url: /\/domain-verification$/, status: [404] },
  { url: /\/api\/studio\/library\/recommended/, status: [404] },
  // A new organisation has no plan: generating and website scans stop at the billing gate (the
  // upgrade dialog opens).
  { url: /\/api\/studio\/projects\/[^/]+\/generate$/, status: [402] },
  { url: /\/api\/studio\/businesses\/[^/]+\/scan-website$/, status: [402] },
];

class Watcher {
  readonly issues: Issue[] = [];
  private current = '';
  /** Without an organisation every workspace API answers 403; the shell then goes to /welcome. */
  noOrganisation = false;

  constructor(private readonly page: Page) {
    page.on('pageerror', (err) =>
      this.issues.push({ page: this.current, kind: 'pageerror', detail: err.message }),
    );
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      // The browser logs every failed fetch as a console error; those are reported as http issues.
      if (/Failed to load resource/.test(text)) return;
      this.issues.push({ page: this.current, kind: 'console', detail: text.slice(0, 300) });
    });
    page.on('response', (res) => void this.onResponse(res));
  }

  private async onResponse(res: Response): Promise<void> {
    const url = res.url();
    if (!url.includes('/api/')) return;
    const status = res.status();
    if (status < 400) return;
    if (status < 500 && EXPECTED_4XX.some((e) => e.url.test(url) && e.status.includes(status))) {
      return;
    }
    const page = this.current;
    // Without an organisation every workspace API answers 403 no_organisation: that is the
    // signal the shell uses to send the user to /welcome, not an error the user sees.
    if (status === 403 && this.noOrganisation) return;
    if (status === 403) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (body.error === 'no_organisation') return;
    }
    this.issues.push({
      page,
      kind: 'http',
      detail: `${res.request().method()} ${new URL(url).pathname} → ${status}`,
    });
  }

  async visit(path: string, opts: { expectPath?: RegExp } = {}): Promise<void> {
    this.current = path;
    await this.page.goto(path);
    await this.settle();
    const origin = new URL(this.page.url()).origin;
    const expectedOrigin = new URL(test.info().project.use.baseURL ?? origin).origin;
    if (origin !== expectedOrigin) {
      this.issues.push({ page: path, kind: 'redirect', detail: `left the site for ${origin}` });
    }
    if (opts.expectPath && !opts.expectPath.test(new URL(this.page.url()).pathname)) {
      this.issues.push({
        page: path,
        kind: 'redirect',
        detail: `ended on ${new URL(this.page.url()).pathname}, expected ${opts.expectPath}`,
      });
    }
    await this.check(path);
  }

  label(name: string): void {
    this.current = name;
  }

  async settle(): Promise<void> {
    await this.page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  }

  async check(name = this.current): Promise<void> {
    const body = (
      await this.page
        .locator('body')
        .innerText()
        .catch(() => '')
    ).trim();
    if (!body) this.issues.push({ page: name, kind: 'blank', detail: 'empty body' });
    for (const re of ERROR_TEXT) {
      if (re.test(body)) this.issues.push({ page: name, kind: 'banner', detail: String(re) });
    }
    const snapDir = process.env.E2E_SWEEP_SNAPSHOTS;
    if (snapDir) {
      mkdirSync(snapDir, { recursive: true });
      const snap = await this.page
        .locator('body')
        .ariaSnapshot()
        .catch(() => '');
      writeFileSync(join(snapDir, `${name.replace(/[^a-z0-9]+/gi, '_')}.yml`), snap);
    }
    const shoot = process.env.E2E_SWEEP_SHOTS_ALL || this.issues.some((i) => i.page === name);
    if (shotsDir && shoot) {
      mkdirSync(shotsDir, { recursive: true });
      await this.page
        .screenshot({
          path: join(shotsDir, `${name.replace(/[^a-z0-9]+/gi, '_')}.png`),
          fullPage: true,
        })
        .catch(() => undefined);
    }
  }
}

async function signIn(page: Page, as = email): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel(/email/i).fill(as);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 30_000 }),
    page.getByRole('button', { name: /sign in/i }).click(),
  ]);
}

/** Sign up through the form and mark the address verified (no inbox in this test). */
async function signUp(page: Page, as: string, name: string): Promise<void> {
  await page.goto('/sign-up');
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel(/email/i).fill(as);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /sign up|create account/i }).click();
  await expect
    .poll(
      async () =>
        (await db.user.updateMany({ where: { email: as }, data: { emailVerified: true } })).count,
      { timeout: 15_000 },
    )
    .toBe(1);
}

const WORKSPACE_PAGES = [
  // 25.4: the signed-in home.
  '/home',
  '/new',
  '/projects',
  '/library',
  '/templates',
  '/publications',
  '/calendar',
  '/analytics',
  '/business',
  // 25.8: Image Studio.
  '/images',
  '/connections',
  '/approvals',
  '/settings/organisation',
  '/settings/members',
  '/settings/billing',
  '/settings/audit',
];

const ACCOUNT_PAGES = ['/account/profile', '/account/security', '/account/export'];

test.skip(!hasDb, 'DATABASE_URL is not set: the sweep needs the app’s database');
test.describe.configure({ mode: 'serial' });

let db: PrismaClient;
test.beforeAll(() => {
  db = new PrismaClient();
});
test.afterAll(async () => {
  // The seeded reference would show up in other runs' library searches.
  const items = await db.videoLibraryItem.findMany({ where: { title: `Sweep reference ${run}` } });
  const ids = items.map((i) => i.id);
  await db.videoLibraryAnalysis.deleteMany({ where: { libraryItemId: { in: ids } } });
  await db.videoLibraryLicense.deleteMany({ where: { libraryItemId: { in: ids } } });
  await db.videoLibraryItem.deleteMany({ where: { id: { in: ids } } });
  await db?.$disconnect();
});

/** A licensed library item with an analysis (the local and CI corpus is empty). */
async function seedLibraryItem(): Promise<string> {
  const category = await db.videoLibraryCategory.findFirstOrThrow({ orderBy: { depth: 'desc' } });
  const item = await db.videoLibraryItem.create({
    data: {
      title: `Sweep reference ${run}`,
      categoryId: category.id,
      tags: ['sweep', 'bakery'],
      s3Bucket: 'ci-library',
      s3Key: `sweep/${run}.mp4`,
      thumbnailS3Key: `sweep/${run}.jpg`,
      durationSec: 21,
      aspectRatio: '9:16',
      license: { create: { scenario: 'OWNED', allowedModes: ['TEMPLATE', 'INSPIRE'] } },
      analysis: {
        create: {
          shotCount: 2,
          shots: [
            { startSec: 0, endSec: 9, type: 'HOOK_TEXT_ON_STILL', overlayStyle: 'bold-centre' },
            { startSec: 9, endSec: 21, type: 'PRODUCT_SHOT', voiceoverPresent: true },
          ],
          transcript: { words: [] },
          overlayTimeline: [],
          musicEnvelope: { bpm: 96, energy: 'medium', mood: 'warm', genre: 'acoustic' },
          hookPattern: 'question',
          structurePattern: 'hook-demo-cta',
          ctaPattern: 'visit',
          paceTag: 'medium',
          moodTag: 'warm',
        },
      },
    },
  });
  return item.id;
}

async function report(w: Watcher): Promise<void> {
  if (w.issues.length) {
    const text = JSON.stringify(w.issues, null, 2);
    process.stdout.write(`SWEEP ISSUES\n${text}\n`);
    await test.info().attach('sweep-issues.json', { body: text, contentType: 'application/json' });
  }
  // E2E_SWEEP_SOFT=1: list every issue without failing (exploring a new build).
  if (!process.env.E2E_SWEEP_SOFT) expect(w.issues).toEqual([]);
}

test('signed-out pages load without errors', async ({ page }) => {
  const w = new Watcher(page);
  for (const path of ['/', '/pricing', '/sign-in', '/sign-up', '/forgot-password']) {
    await w.visit(path);
  }
  for (const doc of ['terms', 'privacy', 'cookies', 'acceptable-use', 'dpa', 'subprocessors']) {
    await w.visit(`/legal/${doc}`);
  }
  await w.visit('/reset-password');
  await expect(page.getByRole('main')).not.toBeEmpty();
  await w.visit('/verify-email');
  // App pages redirect to sign-in.
  await w.visit('/projects', { expectPath: /^\/sign-in/ });
  // A missing page is a friendly 404, not a crash.
  const res = await page.goto('/this-page-does-not-exist');
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
  await w.check('/404');
  await report(w);
});

test('a user with no organisation is sent to the welcome wizard, then sets one up', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const w = new Watcher(page);
  await signUp(page, email, 'Sweep Tester');
  await signIn(page);
  w.noOrganisation = true;

  // Workspace pages and the organisation export go to the wizard; account settings stay.
  for (const path of [...WORKSPACE_PAGES, '/account/export']) {
    await w.visit(path, { expectPath: /^\/welcome$/ });
  }
  for (const path of ['/account/profile', '/account/security']) await w.visit(path);

  w.label('/welcome wizard');
  await page.goto('/welcome');
  await expect(page.getByRole('heading', { name: 'Name your organisation' }).first()).toBeVisible();
  await page.getByLabel('Organisation name').fill(`Sweep Bakery ${run}`);
  await page.getByLabel('Country').selectOption('GB');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  w.noOrganisation = false;
  await expect(
    page.getByRole('heading', { name: 'Add your first business' }).first(),
  ).toBeVisible();
  await page.getByLabel('Business name').fill(`Sweep Sourdough ${run}`);
  await page.getByRole('button', { name: 'Add business' }).click();
  await expect(
    page.getByRole('heading', { name: 'Your brand in three clicks' }).first(),
  ).toBeVisible();
  await w.check('/welcome brand kit');
  await page.getByRole('radio', { name: 'Inter' }).click();
  await page.getByRole('checkbox', { name: 'Warm' }).click();
  await page.getByRole('button', { name: 'Save brand kit' }).click();
  await w.settle();
  await w.check('/welcome brand kit saved');
  // The "… added." toast slides in over the wizard's buttons (bottom corner); wait for it to go
  // so the click is not swallowed by the toast mid-animation.
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 15_000 });
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page.getByRole('heading', { name: 'Connect where you post' }).first()).toBeVisible();
  await w.check('/welcome connect');
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page.getByRole('heading', { name: 'Make your first video' }).first()).toBeVisible();
  await w.check('/welcome first video');
  await page.getByRole('button', { name: 'Make my intro video' }).click();
  await expect(page.getByRole('dialog', { name: 'Choose a plan to start creating' })).toBeVisible();
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(page.getByRole('link', { name: /Open your video/ })).toBeVisible();
  await report(w);
});

test('every workspace page loads for an organisation owner', async ({ page }) => {
  test.setTimeout(600_000);
  const w = new Watcher(page);
  await signIn(page);
  for (const path of [...WORKSPACE_PAGES, ...ACCOUNT_PAGES]) await w.visit(path);

  // A project detail page (the intro video from the wizard).
  const org = await db.organization.findFirstOrThrow({ where: { name: `Sweep Bakery ${run}` } });
  const project = await db.videoProject.findFirst({
    where: { organisationId: org.id },
    select: { id: true },
  });
  expect(project).not.toBeNull();
  await w.visit(`/projects/${project!.id}`);

  await report(w);
});

test('an organisation owner can use every workflow that needs no provider', async ({ page }) => {
  test.setTimeout(600_000);
  const w = new Watcher(page);
  await signIn(page);

  // Create: every source, then a slideshow draft (a new organisation stops at the plan gate).
  await w.visit('/new');
  // 25.7: the formats are a rail of radios above the brief.
  for (const source of ['AI video', 'Slideshow', 'Your video']) {
    const radio = page.getByRole('radio', { name: source, exact: true });
    if (await radio.count()) await radio.click();
    // 20.12: with no connected account the form says the work is saved for review (it never
    // blocks on "choose an account to auto-publish to").
    await expect(page.getByText(/No connected accounts —/).first()).toBeVisible();
  }
  await w.check('/new sources');

  // Projects: every filter tab; a project's panels.
  await w.visit('/projects');
  for (const tab of ['In progress', 'To review', 'Drafts', 'Published', 'Failed', 'All']) {
    await page.getByRole('radio', { name: tab }).click();
    await w.settle();
  }
  await w.check('/projects tabs');
  await page
    .getByRole('link', { name: /Introduce yourself/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/projects\/[^/]+$/);
  w.label('/projects/:id panels');
  for (const tab of ['Shots', 'Overlays', 'Script', 'Publish', 'Variants']) {
    await page.getByRole('tab', { name: tab }).click();
    await w.settle();
  }
  await w.check();

  // Reference library: a licensed reference (the corpus is empty here), its detail page and
  // "Make one like this" / "Same video, my content", which open Create with the reference.
  const libraryId = await seedLibraryItem();
  await w.visit('/library');
  await w.visit(`/library/${libraryId}`);
  await expect(page.getByRole('heading', { name: `Sweep reference ${run}` })).toBeVisible();
  for (const mode of ['Make one like this', 'Same video, my content']) {
    await page.getByRole('link', { name: new RegExp(mode) }).click();
    await expect(page).toHaveURL(/\/new\?/);
    await w.settle();
    await w.check(`/new from reference (${mode})`);
    await page.goBack();
  }

  // Publications filters, analytics ranges.
  await w.visit('/publications');
  // 25.3 / 25.9: the filters are one radio group (no tabs without panels), kept in the URL.
  for (const filter of ['Scheduled', 'Live', 'Failed', 'Cancelled & taken down', 'All']) {
    await page.getByRole('radio', { name: filter }).click();
    await w.settle();
  }
  await w.check('/publications filters');
  await w.visit('/analytics');
  for (const range of ['7 days', '90 days', '30 days']) {
    await page.getByRole('radio', { name: range }).click();
    await w.settle();
  }
  // 25.11: the growth chart switches Views / Watch time; engagement has its own section.
  for (const metric of ['Watch time', 'Views']) {
    await page.getByRole('radio', { name: metric }).click();
  }
  await w.check('/analytics ranges');

  // Calendar: month navigation and a posting schedule (20.14: 3 a week, system times).
  await w.visit('/calendar');
  await page.getByRole('button', { name: 'Next month' }).click();
  await w.settle();
  await page.getByRole('button', { name: 'Previous month' }).click();
  await page.getByRole('button', { name: 'Today' }).click();
  // 25.9: Week and Day views over the same data, then the posting times in their side sheet.
  await page.getByRole('radio', { name: 'Week' }).click();
  await w.settle();
  await page.getByRole('radio', { name: 'Day' }).click();
  await w.settle();
  await page.getByRole('radio', { name: 'Month' }).click();
  await page.getByRole('button', { name: 'Posting times', exact: true }).click();
  const times = page.getByRole('dialog', { name: 'Posting times' });
  await times.getByRole('radio', { name: 'Times a week' }).click();
  await times.getByLabel('Posts a week').selectOption('3');
  await times.getByRole('radio', { name: 'Pick times for me' }).click();
  await times.getByRole('button', { name: /Save schedule/ }).click();
  await w.settle();
  await page.keyboard.press('Escape');
  await expect(page.getByText(/open slot/i).first()).toBeVisible();
  await w.check('/calendar posting plan');

  // Business & images: every tab.
  await w.visit('/business');
  for (const tab of ['Website scan', 'Brand kits', 'Image library', 'What Studio has learned']) {
    await page.getByRole('tab', { name: tab }).click();
    await w.settle();
  }
  await w.check('/business tabs');

  // Approval workflows: create, then delete.
  await w.visit('/approvals');
  await page.getByRole('button', { name: 'New workflow' }).first().click();
  await page.getByLabel('Name').fill('Client sign-off');
  await page
    .getByRole('button', { name: /^(Create|Save)/ })
    .last()
    .click();
  await expect(page.getByText('Workflow created.').first()).toBeVisible();
  await page.getByRole('button', { name: 'Delete Client sign-off' }).click();
  await page.getByRole('button', { name: 'Confirm delete' }).click();
  await expect(page.getByText(/Deleted “Client sign-off”/).first()).toBeVisible();
  await w.check('/approvals create+delete');

  // Settings: organisation save, Your plan (21.5: channels and how often you pay), members.
  await w.visit('/settings/organisation');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await w.settle();
  await w.check('/settings/organisation save');
  await w.visit('/settings/billing');
  await expect(page.getByRole('heading', { name: 'Your plan', level: 1 })).toBeVisible();
  const period = page.getByRole('radiogroup', { name: 'How often you pay' }).first();
  await period.getByRole('radio', { name: 'Yearly' }).click();
  await expect(period.getByRole('radio', { name: 'Yearly' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByRole('button', { name: 'Add a channel' }).first().click();
  await w.settle();
  await w.check('/settings/billing yearly, channels');
  await w.visit('/settings/members');

  // Account: profile save, delete-account section untouched, export page.
  await w.visit('/account/profile');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await w.settle();
  await w.check('/account/profile save');
  await w.visit('/account/export');

  // Header: notifications; the account menu (25.4): feedback dialog, dark theme, language
  // (Arabic is right-to-left).
  await page.getByRole('button', { name: 'Notifications' }).click();
  await w.settle();
  await page.keyboard.press('Escape');
  await openFeedback(page);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await chooseTheme(page, 'Dark');
  await expect(page.locator('html')).toHaveClass(/dark/);
  await w.check('/header dark');
  await chooseLanguage(page, /العربية/);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await w.visit('/calendar');
  await w.visit('/projects');
  await chooseLanguage(page, /Deutsch/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await w.visit('/settings/billing');
  await chooseLanguage(page, /English \(UK\)/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-GB');
  await report(w);
});

test('an owner sends feedback, invites, scans, saves a brand kit and requests an export', async ({
  page,
}) => {
  test.setTimeout(600_000);
  const w = new Watcher(page);
  // Background jobs (scan, export) need the queue (Redis 5+); the page must answer either way.
  await signIn(page);

  w.label('/feedback');
  await openFeedback(page);
  const feedback = page.getByRole('dialog');
  await feedback.getByLabel('Message').fill('QA sweep: every page loads.');
  await feedback.getByRole('button', { name: 'Send' }).click();
  await expect(
    page.getByText(/Thanks — the PostMind team reads every message/).first(),
  ).toBeVisible();
  await w.check();

  await w.visit('/settings/members');
  await page.getByLabel('Email address').fill(`invitee-${run}@example.test`);
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await w.settle();
  await w.check('/settings/members invite');

  await w.visit('/business');
  await page.getByRole('tab', { name: 'Brand kits' }).click();
  await w.settle();
  await w.check('/business brand kits');
  await page.getByRole('tab', { name: 'Website scan' }).click();
  await page.getByLabel('Website address').fill('example.com');
  const ownership = page.getByLabel(/I own this website/);
  if (await ownership.count()) await ownership.check();
  await page.getByRole('button', { name: 'Scan website' }).click();
  await w.settle();
  await w.check('/business scan');

  await w.visit('/account/export');
  await page.getByRole('button', { name: 'Request export' }).click();
  await w.settle();
  await w.check('/account/export request');
  await report(w);
});

test('a superadmin with no organisation reaches every admin tab', async ({ page }) => {
  test.setTimeout(600_000);
  const w = new Watcher(page);
  // Like the first server's operator (scripts/auth/create-superadmin.ts): staff, no organisation
  // (PR #46 keeps /admin reachable while workspace pages go to /welcome).
  const staffEmail = `sweep-staff-${run}@example.test`;
  await signUp(page, staffEmail, 'Sweep Staff');
  await db.user.update({ where: { email: staffEmail }, data: { role: 'superadmin' } });
  // Signing in lands on a workspace page, which sends a user with no organisation to /welcome.
  w.noOrganisation = true;
  await signIn(page, staffEmail);

  // Admin tools need 2FA: turn it on through the account page.
  w.label('/account/security 2FA');
  await enableTwoFactor(page, password);
  await expect(page.getByText('Two-step verification is on.').first()).toBeVisible();
  await w.check();
  // From here on a 403 is an error: the Admin Centre must work without an organisation.
  w.noOrganisation = false;

  await w.visit('/admin', { expectPath: /^\/admin$/ });
  await expect(page.getByRole('heading', { name: 'Admin Centre' })).toBeVisible();
  // 25.13: the sections are links in the admin side menu.
  const tabs = page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link');
  await tabs.first().waitFor();
  const count = await tabs.count();
  for (let i = 0; i < count; i += 1) {
    const tab = tabs.nth(i);
    const name = (await tab.innerText()).trim();
    w.label(`/admin ${name}`);
    await tab.click();
    await w.settle();
    await w.check();
  }

  // 20.27: staff end an organisation's trial and move it to PLUS from Organisations.
  const trialOrg = `sweep-trial-${run}`;
  const started = new Date();
  await db.organization.create({
    data: { id: trialOrg, name: `Sweep Trial ${run}`, slug: trialOrg },
  });
  await db.orgEntitlement.create({
    data: {
      organisationId: trialOrg,
      tier: 'STANDARD',
      access: 'full',
      source: 'trial',
      trialStartedAt: started,
      overrides: {
        derived: { tier: 'STANDARD', access: 'full', source: 'trial', status: 'trialing' },
        trial: {
          startedAt: started.toISOString(),
          endsAt: new Date(started.getTime() + 14 * 86_400_000).toISOString(),
          shortVideos: 5,
          longVideos: 1,
          dailyCostCapPence: 1_000,
          totalCostCapPence: 1_500,
        },
      },
    },
  });
  w.label('/admin organisations: end trial');
  await page
    .getByRole('navigation', { name: 'Admin sections' })
    .getByRole('link', { name: 'Organisations' })
    .click();
  await page.getByLabel('Search organisations').fill(`Sweep Trial ${run}`);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: `Open Sweep Trial ${run}` }).click();
  await expect(page.getByText('Running: the trial’s caps apply now.')).toBeVisible();
  const form = page.getByRole('form', { name: 'Set an override' });
  await form.getByLabel('Tier').selectOption('PLUS');
  await form.getByRole('checkbox', { name: 'End the trial now' }).check();
  await form.getByLabel('Reason (required)').fill('Sweep: end the trial');
  await form.getByRole('button', { name: 'Save override' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Yes, save' }).click();
  await expect(page.getByText(/Ended by staff on/)).toBeVisible();
  await w.settle();
  await w.check();
  const stored = await db.orgEntitlement.findUnique({ where: { organisationId: trialOrg } });
  expect(stored).toMatchObject({ tier: 'PLUS', source: 'admin' });
  await report(w);
});
