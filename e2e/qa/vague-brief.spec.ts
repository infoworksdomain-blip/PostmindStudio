import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { createAccount, queueWorks, removeAccount, signIn, type Account } from './support';
import { Watcher } from './watcher';

// BACKLOG 20.18 — "video generation is not working" (operator, 2026-10-02): a vague brief ended in
// DRAFT with nowhere to choose a direction. Through the real UI: the gentle hint on Create, the
// projects-list reason linking to the project page, the "choose a direction" panel (use a
// suggestion, or edit the brief) and the restricted-topics panel (spec 13.3: continue anyway, or
// edit the brief), the same dead end before 20.18. The projects are seeded through Prisma; no
// provider is called (with a queue the run is queued and never worked; without one the 502 is part
// of the scenario).

const hasDb = Boolean(process.env.DATABASE_URL);
test.skip(!hasDb, 'DATABASE_URL is not set: the QA specs need the app’s database');
test.describe.configure({ mode: 'serial' });

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3102';
const run = randomUUID().slice(0, 8);
const VAGUE_REASON = 'brief_too_vague: choose one of the suggested directions';
const DIRECTIONS = [
  'A countdown to our launch with a rocket animation',
  'Three facts about space our customers love',
  'Behind the scenes of our space-themed studio',
];
const HINT = /This is quite short\. Add who it’s for, what to say, or the feel you want/;
const GENERATE = /\/api\/studio\/projects\/[^/]+\/generate$/;

let db: PrismaClient;
let queueUp = false;
let account: Account;
let storageState = '';
let ipCounter = 0;

// Better Auth rate-limits per client IP (x-real-ip when no proxy is trusted) and every spec runs
// from 127.0.0.1, so each context claims its own address instead of sharing the sweep's bucket.
function uniqueIp(): string {
  ipCounter += 1;
  const base = Number.parseInt(run.slice(0, 4), 16) % 150;
  return `10.${60 + base}.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

async function newPage(browser: Browser, width = 1280): Promise<Page> {
  const context = await browser.newContext({
    storageState,
    locale: 'en-GB',
    viewport: { width, height: 900 },
    extraHTTPHeaders: { 'x-real-ip': uniqueIp() },
  });
  return context.newPage();
}

async function seedVagueProject(name: string): Promise<string> {
  const project = await db.videoProject.create({
    data: {
      organisationId: account.organisationId,
      businessId: account.businessId,
      createdByUserId: account.userId,
      name,
      description: 'space video',
      state: 'DRAFT',
      sourceType: 'BRIEF',
      targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 15 }],
      errorReason: VAGUE_REASON,
      metadata: { runId: randomUUID(), directionOptions: DIRECTIONS, lastBriefVague: true },
    },
  });
  return project.id;
}

const RESTRICTED_REASON = 'restricted_topics: user confirmation required (spec 13.3)';
const TOPICS = ['politics', 'elections'];
const RESTRICTED_BRIEF = 'Election day offer for our members';

async function seedRestrictedProject(name: string): Promise<string> {
  const project = await db.videoProject.create({
    data: {
      organisationId: account.organisationId,
      businessId: account.businessId,
      createdByUserId: account.userId,
      name,
      description: RESTRICTED_BRIEF,
      state: 'DRAFT',
      sourceType: 'BRIEF',
      targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 15 }],
      errorReason: RESTRICTED_REASON,
      metadata: { runId: randomUUID(), pendingRestrictedTopics: TOPICS },
    },
  });
  return project.id;
}

/** What a panel's generate click must leave behind (started, or rolled back without a queue). */
interface Outcome {
  panel: string;
  sent: string;
  /** Metadata the started run carries. */
  started: Record<string, unknown>;
  /** The brief and metadata a rolled-back click must keep. */
  kept: { description: string; metadata: Record<string, unknown> };
}

const directionsOutcome = (sent: string): Outcome => ({
  panel: 'Choose a direction',
  sent,
  started: { directionChosen: true },
  kept: { description: 'space video', metadata: { directionOptions: DIRECTIONS } },
});

/** A Watcher with the answers that are normal here: a new business has no website profile yet. */
function watch(page: Page): Watcher {
  const w = new Watcher(page);
  w.expect4xx(/\/api\/studio\/businesses\/[^/]+\/business-profile$/, 404);
  return w;
}

function report(w: Watcher): void {
  if (w.issues.length) process.stdout.write(`QA ISSUES\n${JSON.stringify(w.issues, null, 2)}\n`);
  expect(w.issues).toEqual([]);
}

/** After a generate click: started (queue up), or a 502 that left the project as it was. */
async function expectGenerateOutcome(
  page: Page,
  w: Watcher,
  id: string,
  outcome: Outcome,
): Promise<void> {
  if (queueUp) {
    await expect(page.getByText('Generation started.').first()).toBeVisible();
    await expect
      .poll(async () => (await db.videoProject.findUniqueOrThrow({ where: { id } })).state)
      .not.toBe('DRAFT');
    const row = await db.videoProject.findUniqueOrThrow({ where: { id } });
    expect(row.description).toBe(outcome.sent);
    expect(row.errorReason).toBeNull();
    expect(row.metadata).toMatchObject(outcome.started);
    return;
  }
  w.expect4xx(GENERATE, 502);
  const panel = page.getByRole('region', { name: outcome.panel });
  await expect(panel.getByRole('alert')).toBeVisible();
  const row = await db.videoProject.findUniqueOrThrow({ where: { id } });
  expect(row.state).toBe('DRAFT');
  // Rolled back: the brief and what the panel lists are still there.
  expect(row.description).toBe(outcome.kept.description);
  expect(row.metadata).toMatchObject(outcome.kept.metadata);
}

test.beforeAll(async ({ browser, playwright }) => {
  test.setTimeout(180_000);
  db = new PrismaClient();
  queueUp = await queueWorks();
  const request = await playwright.request.newContext({ baseURL });
  account = await createAccount(db, request, baseURL, {
    label: `vague-${run}`,
    tier: 'STANDARD',
    connect: { tiktok: 'Space TikTok' },
  });
  await request.dispose();
  // Sign in once; every test reuses the session (one sign-in per spec, not per test).
  const page = await browser.newPage();
  await signIn(page, account.email);
  storageState = test.info().outputPath('vague-brief-state.json');
  await page.context().storageState({ path: storageState });
  await page.context().close();
});

test.afterAll(async () => {
  if (account) await removeAccount(db, account);
  await db?.$disconnect();
});

test('Create shows a gentle hint for a short brief and still generates', async ({ browser }) => {
  const page = await newPage(browser);
  const w = watch(page);
  if (!queueUp) w.expect4xx(GENERATE, 502);
  await w.visit('/new');
  const brief = page.locator('#create-brief');
  await brief.fill('space video');
  const hint = page.getByTestId('brief-hint');
  await expect(hint).toHaveText(HINT);
  await expect(brief).toHaveAttribute('aria-describedby', 'create-brief-hint');

  await brief.fill('A launch teaser for our space app, for startup founders, playful and bold');
  await expect(hint).toHaveCount(0);

  // The hint never blocks: a short brief still creates the project.
  await brief.fill('space video');
  await expect(hint).toBeVisible();
  await page.getByRole('button', { name: 'Generate' }).click();
  await expect(page).toHaveURL(/\/projects\/[^/#]+$/, { timeout: 60_000 });
  const created = await db.videoProject.findFirstOrThrow({
    where: { organisationId: account.organisationId, description: 'space video' },
    orderBy: { createdAt: 'desc' },
  });
  expect(created.sourceType).toBe('BRIEF');
  await w.settle();
  await w.check('/projects/:id after a short brief');
  report(w);
  await page.context().close();
});

test('the projects list names the problem and opens the directions panel', async ({ browser }) => {
  const id = await seedVagueProject(`QA vague list ${run}`);
  const page = await newPage(browser);
  const w = watch(page);
  await w.visit('/projects');
  const row = page.locator(`a[href="/projects/${id}#directions"]`);
  await expect(row).toContainText(
    'The brief was too vague to plan a video. Choose one of the suggested directions.',
  );
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${id}#directions$`));
  const panel = page.getByRole('region', { name: 'Choose a direction' });
  await expect(panel).toContainText(
    'Your request is a bit too vague to make a good video. Pick one of these directions, or add more detail below.',
  );
  const cards = panel.getByRole('list', { name: 'Suggested directions' }).getByRole('listitem');
  await expect(cards).toHaveCount(3);
  for (const direction of DIRECTIONS) await expect(panel).toContainText(direction);
  // The current brief is in the editor, with the hint because it is short.
  await expect(panel.getByLabel('Your brief')).toHaveValue('space video');
  await expect(panel.getByTestId('brief-hint')).toBeVisible();

  await panel.getByRole('button', { name: 'Use direction 2' }).click();
  await expectGenerateOutcome(page, w, id, directionsOutcome(DIRECTIONS[1] as string));
  await w.check(`/projects/${id} after choosing`);
  report(w);
  await page.context().close();
});

test('the brief can be edited and generated from the panel', async ({ browser }) => {
  const id = await seedVagueProject(`QA vague edit ${run}`);
  const page = await newPage(browser);
  const w = watch(page);
  await w.visit(`/projects/${id}`);
  const panel = page.getByRole('region', { name: 'Choose a direction' });
  const box = panel.getByLabel('Your brief');
  await box.fill('');
  await expect(panel.getByRole('button', { name: 'Generate with my changes' })).toBeDisabled();
  const edited = 'A 20-second space-themed teaser for our app launch, aimed at startup founders';
  await box.fill(edited);
  await expect(panel.getByTestId('brief-hint')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Generate with my changes' }).click();
  await expectGenerateOutcome(page, w, id, directionsOutcome(edited));
  report(w);
  await page.context().close();
});

test('the panel fits a 375 px phone without sideways scrolling', async ({ browser }) => {
  const id = await seedVagueProject(`QA vague mobile ${run}`);
  const page = await newPage(browser, 375);
  const w = watch(page);
  await w.visit(`/projects/${id}`);
  await expect(page.getByRole('region', { name: 'Choose a direction' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow, 'horizontal overflow at 375px').toBe(false);
  report(w);
  await page.context().close();
});

test('restricted topics: the list links to the panel, which lists them; Continue anyway', async ({
  browser,
}) => {
  const id = await seedRestrictedProject(`QA restricted ${run}`);
  const page = await newPage(browser);
  const w = watch(page);
  await w.visit('/projects');
  const row = page.locator(`a[href="/projects/${id}#restricted-topics"]`);
  await expect(row).toContainText('The brief touches a restricted topic. Confirm it to continue.');
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${id}#restricted-topics$`));
  const panel = page.getByRole('region', { name: 'Check the restricted topics' });
  const topics = panel.getByRole('list', { name: 'Restricted topics found' }).getByRole('listitem');
  await expect(topics).toHaveText(TOPICS);
  await expect(panel.getByLabel('Your brief')).toHaveValue(RESTRICTED_BRIEF);

  await panel.getByRole('button', { name: 'Continue anyway' }).click();
  await expectGenerateOutcome(page, w, id, {
    panel: 'Check the restricted topics',
    sent: RESTRICTED_BRIEF,
    started: { restrictedTopicsConfirmed: true },
    kept: { description: RESTRICTED_BRIEF, metadata: { pendingRestrictedTopics: TOPICS } },
  });
  report(w);
  await page.context().close();
});

test('restricted topics: the brief can be edited and generated instead', async ({ browser }) => {
  const id = await seedRestrictedProject(`QA restricted edit ${run}`);
  const page = await newPage(browser);
  const w = watch(page);
  await w.visit(`/projects/${id}`);
  const panel = page.getByRole('region', { name: 'Check the restricted topics' });
  const edited = 'A members-only autumn offer with free delivery this weekend';
  await panel.getByLabel('Your brief').fill(edited);
  await panel.getByRole('button', { name: 'Generate with my changes' }).click();
  await expectGenerateOutcome(page, w, id, {
    panel: 'Check the restricted topics',
    sent: edited,
    started: {},
    kept: { description: RESTRICTED_BRIEF, metadata: { pendingRestrictedTopics: TOPICS } },
  });
  report(w);
  await page.context().close();
});
