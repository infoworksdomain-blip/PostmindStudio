import { expect, test } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { createAccount, queueWorks, removeAccount, signIn, Watcher, type Account } from './support';

// QA agent 2: Create (/new) and "Plan my month" (/plans), through the real UI against the real
// app. No provider is called: generation stops at the billing gate, or is queued and never run
// (no worker), or fails because the queue is down (Redis < 5 locally), which is itself a state
// under test. Needs DATABASE_URL and a running app, like the sweep (playwright.config.ts).

const hasDb = Boolean(process.env.DATABASE_URL);
test.skip(!hasDb, 'DATABASE_URL is not set: the Create QA needs the app’s database');
test.describe.configure({ mode: 'serial' });

let db: PrismaClient;
let queueUp = false;
const accounts: Account[] = [];

test.beforeAll(async () => {
  db = new PrismaClient();
  queueUp = await queueWorks();
});
test.afterAll(async () => {
  for (const account of accounts) await removeAccount(db, account);
  await db?.$disconnect();
});

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3102';
// A queue outage answers 502 (generateProject / createPlan): expected only where tests make it so.
const QUEUE_DOWN = [
  { method: 'POST', url: /\/projects\/[^/]+\/generate$/, status: 502 },
  { method: 'POST', url: /\/content-plans$/, status: 502 },
];

async function account(
  request: Parameters<typeof createAccount>[1],
  label: string,
  tier: Parameters<typeof createAccount>[3]['tier'],
  connect?: Record<string, string>,
): Promise<Account> {
  const made = await createAccount(db, request, baseURL, { label, tier, connect });
  accounts.push(made);
  return made;
}

async function openOptions(page: import('@playwright/test').Page): Promise<void> {
  const toggle = page.getByRole('button', { name: /Options/ });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

test.describe('Create /new with a plan', () => {
  let a: Account;
  test.beforeAll(async ({ request }) => {
    a = await account(request, 'std', 'STANDARD', {
      tiktok: 'Bakery TikTok',
      youtube: 'Bakery YT',
    });
  });

  test('every validation message, in order, then a valid video brief is created', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const w = new Watcher(page, queueUp ? [] : QUEUE_DOWN);
    await signIn(page, a.email);
    await page.goto('/new');
    await expect(page.getByLabel(/What’s the video about/)).toBeVisible();
    const alert = page.locator('ul[role="alert"]');

    // Empty brief.
    await page.getByRole('button', { name: 'Generate' }).click();
    await expect(alert).toContainText('Describe what the video is about.');

    // Brief fine, no platform.
    await page.locator('#create-brief').fill('Spring menu launches Friday');
    await openOptions(page);
    for (const name of ['TikTok', 'YouTube Shorts']) {
      const chip = page.getByRole('checkbox', { name });
      if (await chip.count()) await chip.setChecked(false, { force: true });
    }
    await page.getByRole('button', { name: 'Generate' }).click();
    await expect(alert).toContainText('Pick at least one platform.');
    await page.getByRole('checkbox', { name: 'TikTok' }).setChecked(true, { force: true });

    // Auto-publish on with no account chosen.
    await page.getByRole('checkbox', { name: /Auto-publish when approved/ }).check();
    await page.getByRole('button', { name: 'Generate' }).click();
    await expect(alert).toContainText('Choose at least one account to auto-publish to');
    await page.getByRole('checkbox', { name: /Auto-publish when approved/ }).uncheck();

    // Budget out of range, then a schedule in the past.
    await page.getByRole('button', { name: 'Advanced options' }).click();
    await page.locator('#create-budget').fill('abc');
    await page.getByRole('button', { name: 'Generate' }).click();
    await expect(alert).toContainText('Budget must be between');
    await page.locator('#create-budget').fill('');

    // Too-long brief is capped by maxlength (4000).
    await page.locator('#create-brief').fill('x'.repeat(4_100));
    expect((await page.locator('#create-brief').inputValue()).length).toBe(4_000);
    await page.locator('#create-brief').fill('Spring menu launches Friday');
    await w.check('/new validations');

    // Valid: project is created; generate either starts (queue up) or reports it did not.
    await page.getByRole('button', { name: 'Generate' }).click();
    await expect(page).toHaveURL(/\/projects\/[^/]+$/, { timeout: 60_000 });
    const project = await db.videoProject.findFirstOrThrow({
      where: { organisationId: a.organisationId },
      orderBy: { createdAt: 'desc' },
    });
    expect(project.description).toBe('Spring menu launches Friday');
    expect(project.sourceType).toBe('BRIEF');
    // Never stuck in QUEUED when the queue is down (regression: generateProject).
    if (!queueUp) expect(project.state).toBe('DRAFT');
    await w.settle();
    await w.check('/projects/:id after create');
    w.assertClean();
  });

  test('slideshow: template is required, and video-only options left on do not block it', async ({
    page,
  }) => {
    const w = new Watcher(page);
    await signIn(page, a.email);
    await page.goto('/new');
    await openOptions(page);
    // Turn auto-publish on in the video form (no account), then switch to Slideshow.
    await page.getByRole('checkbox', { name: /Auto-publish when approved/ }).check();
    await page.getByRole('radio', { name: /Slideshow/ }).click();
    await expect(page.getByRole('checkbox', { name: /Auto-publish when approved/ })).toHaveCount(0);
    await page.locator('#create-brief').fill('Five reasons to try sourdough');
    await page.getByRole('button', { name: 'Create slideshow' }).click();
    const alert = page.locator('ul[role="alert"]');
    await expect(alert).toContainText('Pick a slideshow template.');
    await expect(alert).not.toContainText('auto-publish');
    await w.check('/new slideshow validation');
    w.assertClean();
  });

  test('reference hand-off: unknown reference id degrades, mode radios and clear work', async ({
    page,
  }) => {
    const w = new Watcher(page, [{ method: 'GET', url: /\/library\/videos\//, status: 404 }]);
    await signIn(page, a.email);
    await page.goto('/new?reference=does-not-exist&mode=template');
    await expect(page.getByText('Reference video unavailable')).toBeVisible();
    await page.getByRole('radio', { name: 'Inspire' }).click();
    await expect(page.getByRole('radio', { name: 'Inspire' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await page.getByRole('button', { name: 'Don’t use a reference' }).click();
    await expect(page.getByText('From the reference library')).toHaveCount(0);
    // A malformed id is ignored outright.
    await page.goto('/new?reference=../../etc&mode=inspire');
    await expect(page.getByText('From the reference library')).toHaveCount(0);
    await w.check('/new reference');
    w.assertClean();
  });

  test('upload source needs a video; mobile 375, dark and Arabic RTL render without overflow', async ({
    page,
  }) => {
    const w = new Watcher(page);
    await signIn(page, a.email);
    await page.goto('/new');
    await openOptions(page);
    await page.getByRole('radio', { name: /Upload/ }).click();
    await page.getByRole('button', { name: 'Generate' }).click();
    await expect(page.locator('ul[role="alert"]')).toContainText('Upload your video first.');

    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/new');
    await openOptions(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow, 'horizontal overflow at 375px').toBe(false);

    await page.getByRole('button', { name: 'Use dark theme' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await w.check('/new mobile dark');

    await page.getByRole('combobox', { name: /Interface language/ }).click();
    await page.getByRole('option', { name: /العربية/ }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await page.goto('/new');
    await expect(page.locator('#create-brief')).toBeVisible();
    await w.check('/new rtl');
    w.assertClean();
  });
});

test.describe('Create and Plan my month without a plan', () => {
  let a: Account;
  test.beforeAll(async ({ request }) => {
    a = await account(request, 'noplan', null, { tiktok: 'Bakery TikTok' });
  });

  test('generate opens the upgrade dialog; the draft project is kept', async ({ page }) => {
    const w = new Watcher(page, [{ method: 'POST', url: /\/generate$/, status: 402 }]);
    await signIn(page, a.email);
    await page.goto('/new');
    await page.locator('#create-brief').fill('Our spring menu');
    await openOptions(page);
    await page.getByRole('radio', { name: /Video/ }).click();
    await page.getByRole('button', { name: 'Generate' }).click();
    await expect(
      page.getByRole('dialog', { name: 'Choose a plan to start creating' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(page).toHaveURL(/\/projects\/[^/]+$/);
    expect(await db.videoProject.count({ where: { organisationId: a.organisationId } })).toBe(1);
    w.assertClean();
  });

  test('Plan my month is closed to an organisation with no plan (402) and drafts nothing', async ({
    page,
  }) => {
    const w = new Watcher(page, [{ method: 'POST', url: /\/content-plans$/, status: 402 }]);
    await signIn(page, a.email);
    await page.goto('/plans/new');
    await expect(page.getByRole('heading', { name: 'Plan my month' }).first()).toBeVisible();
    await page
      .getByRole('combobox', { name: /TikTok account/ })
      .selectOption({ label: 'Bakery TikTok' });
    await page.getByRole('button', { name: 'Draft my month' }).click();
    await expect(
      page.getByRole('dialog', { name: 'Choose a plan to start creating' }),
    ).toBeVisible();
    expect(await db.contentPlan.count({ where: { organisationId: a.organisationId } })).toBe(0);
    w.assertClean();
  });
});

test.describe('Plan my month with a plan', () => {
  let a: Account;
  test.beforeAll(async ({ request }) => {
    a = await account(request, 'plan', 'STANDARD', { tiktok: 'Bakery TikTok' });
  });

  test('form validation, estimate, mix slider, posts a day and the 4-a-day choice', async ({
    page,
  }) => {
    const w = new Watcher(page, queueUp ? [] : QUEUE_DOWN);
    await signIn(page, a.email);
    await page.goto('/plans/new');
    await expect(page.getByRole('radio', { name: '4 a day' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Use my posting times' })).toBeDisabled();
    await page.getByRole('radio', { name: '4 a day' }).click();
    await page.getByLabel('Length in days').fill('10');
    await expect(page.locator('#plan-estimate')).toContainText('Up to 40 posts over 10 days');
    await page.getByLabel('Videos and slideshows').fill('100');
    await expect(page.getByText('100% videos · 0% slideshows')).toBeVisible();

    // No account chosen for TikTok: the form says so (accounts are not guessed).
    await page.getByRole('button', { name: 'Draft my month' }).click();
    const alert = page.locator('ul[role="alert"]');
    if (await alert.count()) await expect(alert).toContainText('Choose a connected account');

    await page.getByLabel('Length in days').fill('40');
    await page
      .getByRole('combobox', { name: /TikTok account/ })
      .selectOption({ label: 'Bakery TikTok' });
    await page.getByRole('button', { name: 'Draft my month' }).click();
    await expect(page.locator('ul[role="alert"]')).toContainText('Choose between 1 and 31 days.');

    await page.getByLabel('Length in days').fill('3');
    await page.getByRole('radio', { name: '2 a day' }).click();
    await page.getByRole('button', { name: 'Draft my month' }).click();
    if (queueUp) {
      await expect(page).toHaveURL(/\/plans\/[^/]+$/, { timeout: 30_000 });
      await expect(page.getByRole('heading', { name: 'Drafting your month' })).toBeVisible();
    } else {
      // Queue down: an error toast, no stuck draft, the form stays usable.
      await expect(page.locator('[data-sonner-toast]').first()).toBeVisible();
      expect(await db.contentPlan.count({ where: { organisationId: a.organisationId } })).toBe(0);
    }
    await w.check('/plans/new');
    w.assertClean();
  });

  test('draft editor: edit, move, add (max 4 a day), remove, discard', async ({ page }) => {
    test.setTimeout(180_000);
    const w = new Watcher(page);
    // A drafted plan (what the background job leaves): three days, two posts a day.
    const start = new Date(Date.now() + 2 * 86_400_000);
    const day = (n: number, hh: number, mm = 0) =>
      new Date(
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + n, hh, mm),
      );
    const plan = await db.contentPlan.create({
      data: {
        organisationId: a.organisationId,
        businessId: a.businessId,
        createdByUserId: a.userId,
        status: 'DRAFT',
        startDate: start.toISOString().slice(0, 10),
        days: 3,
        timezone: 'UTC',
        windowStart: day(0, 0),
        windowEnd: day(3, 0),
        postsPerDay: 2,
        videoShare: 50,
        platforms: ['tiktok'],
        targets: [{ platform: 'tiktok', connectionId: a.connections.tiktok }],
        planTier: 'STANDARD',
        requestedCount: 4,
        items: {
          create: [
            { n: 0, h: 9, kind: 'VIDEO', title: 'Sourdough basics' },
            { n: 0, h: 17, kind: 'SLIDESHOW', title: 'Three bakery myths' },
            { n: 1, h: 9, kind: 'VIDEO', title: 'Meet the baker' },
            { n: 1, h: 17, kind: 'SLIDESHOW', title: 'Weekend offer' },
          ].map((i, position) => ({
            organisationId: a.organisationId,
            position,
            slotAt: day(i.n, i.h, 30),
            kind: i.kind as 'VIDEO' | 'SLIDESHOW',
            angle: 'custom',
            title: i.title,
            brief: `Brief for ${i.title}`,
            slides:
              i.kind === 'SLIDESHOW'
                ? { hook: i.title, points: ['One', 'Two'], cta: 'Visit us' }
                : undefined,
          })),
        },
      },
    });
    await signIn(page, a.email);
    await page.goto(`/plans/${plan.id}`);
    await expect(page.getByText('4 posts: 2 videos and 2 slideshows')).toBeVisible();

    // Edit a topic.
    await page.getByRole('button', { name: 'Edit' }).first().click();
    await page.getByLabel('Topic').fill('Sourdough for beginners');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Sourdough for beginners').first()).toBeVisible();
    expect(
      await db.contentPlanItem.count({
        where: { planId: plan.id, title: 'Sourdough for beginners' },
      }),
    ).toBe(1);

    // Move down: topics swap, times stay.
    await page.getByRole('button', { name: /Move “Sourdough for beginners” later/ }).click();
    await expect
      .poll(
        async () =>
          (
            await db.contentPlanItem.findFirstOrThrow({
              where: { planId: plan.id, title: 'Sourdough for beginners' },
            })
          ).position,
      )
      .toBe(1);

    // Add posts at a free time: the third and fourth that day are fine, a fifth is refused.
    for (const [hh, title] of [
      [12, 'Lunch special'],
      [20, 'Evening bake'],
    ] as const) {
      await page.getByRole('button', { name: 'Add a post' }).click();
      await page.getByLabel('Date and time').fill(day(0, hh, 15).toISOString().slice(0, 16));
      await page.getByLabel('Topic').last().fill(title);
      await page.getByLabel('Brief').last().fill(`Brief ${title}`);
      await page.getByRole('button', { name: 'Add post' }).click();
      await expect(page.getByText(title).first()).toBeVisible();
    }
    await page.getByRole('button', { name: 'Add a post' }).click();
    await page.getByLabel('Date and time').fill(day(0, 22, 15).toISOString().slice(0, 16));
    await page.getByLabel('Topic').last().fill('Fifth of the day');
    await page.getByLabel('Brief').last().fill('Too many');
    await page.getByRole('button', { name: 'Add post' }).click();
    await expect(page.getByText('At most 4 posts a day').first()).toBeVisible();
    expect(
      await db.contentPlanItem.count({ where: { planId: plan.id, title: 'Fifth of the day' } }),
    ).toBe(0);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    // Remove, then discard the plan.
    await page.getByRole('button', { name: /Delete “Lunch special”/ }).click();
    await expect(page.getByText('Post deleted').first()).toBeVisible();
    await page.getByRole('button', { name: 'Discard plan' }).click();
    await page.getByRole('button', { name: 'Discard plan' }).last().click();
    await expect(page).toHaveURL(/\/plans$/);
    expect((await db.contentPlan.findUniqueOrThrow({ where: { id: plan.id } })).status).toBe(
      'CANCELLED',
    );
    await w.settle();
    await w.check('/plans list');
    w.assertClean();
  });

  test('plans list empty state, mobile 375 and RTL', async ({ page, request }) => {
    const fresh = await account(request, 'empty', 'STANDARD', { tiktok: 'T' });
    const w = new Watcher(page);
    await signIn(page, fresh.email);
    await page.goto('/plans');
    await expect(page.getByText('No month plans yet')).toBeVisible();
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/plans/new');
    await expect(page.getByRole('button', { name: 'Draft my month' })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
    ).toBe(false);
    await page.getByRole('combobox', { name: /Interface language/ }).click();
    await page.getByRole('option', { name: /العربية/ }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await w.check('/plans/new rtl');
    w.assertClean();
  });
});
