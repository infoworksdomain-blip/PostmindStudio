import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';

// Phase 18 Track E — the standalone happy path a new visitor takes, with no PostMind Core:
//   landing (/) → pricing (/pricing, Track C) → sign-up (/sign-up, Track A) → email verified →
//   sign in → onboarding (/welcome: organisation, business, brand kit, connect, first video) →
//   the first project exists.
// Email delivery is not part of this test: the verification step marks the new user verified in
// the database (the same row Better Auth's verify link sets), so no inbox is needed.
// Needs DATABASE_URL (the app's database) and a running app (playwright.config.ts).

const hasDb = Boolean(process.env.DATABASE_URL);
const run = randomUUID().slice(0, 8);
const email = `e2e-${run}@example.test`;
const password = `E2e-${randomUUID()}`;

async function markVerified(address: string): Promise<void> {
  const db = new PrismaClient();
  try {
    await expect
      .poll(
        async () =>
          (await db.user.updateMany({ where: { email: address }, data: { emailVerified: true } }))
            .count,
        {
          timeout: 15_000,
        },
      )
      .toBe(1);
  } finally {
    await db.$disconnect();
  }
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  // Wait for the session to be set (the form navigates away on success); navigating straight on
  // would cancel the sign-in request.
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 30_000 }),
    page.getByRole('button', { name: /sign in/i }).click(),
  ]);
}

test.skip(!hasDb, 'DATABASE_URL is not set: the happy path needs the app’s database');

// Step headings use .first(): while the wizard swaps steps the outgoing and incoming panels can
// briefly both be in the tree, which made a strict locator flaky on CI (PR #26).
test('a new visitor goes from the landing page to their first project', async ({ page }) => {
  // Landing: the value proposition, then pricing.
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('A week of short videos');
  await page.getByRole('link', { name: 'See pricing' }).first().click();
  await expect(page).toHaveURL(/\/pricing$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // Sign-up (Track A), from the landing page's call to action.
  await page.goto('/');
  await page.getByRole('link', { name: 'Start free trial' }).first().click();
  await expect(page).toHaveURL(/\/sign-up/);
  await page.getByLabel('Your name').fill('E2E Baker');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /sign up|create account/i }).click();
  await markVerified(email);
  await signIn(page);

  // Onboarding: a user with no organisation starts by creating one.
  await page.goto('/welcome');
  await expect(page.getByRole('heading', { name: 'Name your organisation' }).first()).toBeVisible();
  await page.getByLabel('Organisation name').fill(`E2E Bakery ${run}`);
  await page.getByLabel('Country').selectOption('GB');
  await page.getByRole('button', { name: 'Create organisation' }).click();

  await expect(
    page.getByRole('heading', { name: 'Add your first business' }).first(),
  ).toBeVisible();
  await page.getByLabel('Business name').fill(`E2E Sourdough ${run}`);
  await page.getByRole('button', { name: 'Add business' }).click();

  // Brand kit and Connect can be skipped; the first video is the goal.
  await expect(
    page.getByRole('heading', { name: 'Your brand in three clicks' }).first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Skip this step' }).click();
  await expect(page.getByRole('heading', { name: 'Connect where you post' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Skip this step' }).click();
  await expect(page.getByRole('heading', { name: 'Make your first video' }).first()).toBeVisible();
  await page.getByLabel('Anything to mention? (optional)').fill('Family bakery, E2E run');
  await page.getByRole('button', { name: 'Make my intro video' }).click();

  // A new organisation has no plan yet, so generating stops at the billing gate (402
  // plan_required) and the upgrade dialog opens; the project itself already exists.
  await expect(page.getByRole('dialog', { name: 'Choose a plan to start creating' })).toBeVisible();
  await page.getByRole('button', { name: 'Not now' }).click();

  // The first project exists and opens.
  const open = page.getByRole('link', { name: /Open your video/ });
  await expect(open).toBeVisible();
  await open.click();
  await expect(page).toHaveURL(/\/projects\/[^/]+$/);
});
