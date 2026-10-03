import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  addMember,
  cleanWorld,
  createUser,
  emailFor,
  newDb,
  run,
  seedWorld,
  signedInPage,
  type Db,
  type World,
} from './fixtures';
import { baseURL, staffPage, watch } from './pass2.support';

// 20.31 (QA pass 2) — billing pages (plan picker, annual toggle, top-ups, the Stripe portal link
// in test mode), the calendar's drip queue, and the Admin Centre (every tab loads; Organisations
// -> Open -> plan override and "End the trial now"; cost caps). Stripe is never called: checkout
// and portal answers are mocked in the browser, and the placeholder Stripe keys cannot reach it.

const hasDb = Boolean(process.env.DATABASE_URL);
test.skip(!hasDb, 'DATABASE_URL is not set: the QA specs need the app’s database');
test.describe.configure({ mode: 'serial' });

let db: Db;
let world: World;
let owner: Page;
let staff: Page;
let staffEmail = '';

test.beforeAll(async ({ browser, playwright }) => {
  test.setTimeout(240_000);
  db = newDb();
  const request = await playwright.request.newContext({ baseURL });
  const ownerId = await createUser(request, db, baseURL, emailFor('p2-billing'), 'QA owner');
  world = await seedWorld(db, ownerId);
  await addMember(db, world.orgId, ownerId, 'owner');
  owner = await signedInPage(browser, baseURL, emailFor('p2-billing'));
  const made = await staffPage(browser, request, db);
  staff = made.page;
  staffEmail = made.email;
  await request.dispose();
});

test.afterAll(async () => {
  await owner?.context().close();
  await staff?.context().close();
  await db?.orgEntitlement
    .deleteMany({ where: { organisationId: { startsWith: `p2-trial-${run}` } } })
    .catch(() => undefined);
  await db?.organization
    .deleteMany({ where: { id: { startsWith: `p2-trial-${run}` } } })
    .catch(() => undefined);
  await cleanWorld(db, world);
  const users = await db.user.findMany({
    where: { email: { in: [emailFor('p2-billing'), staffEmail] } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  await db.session.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
  await db.twoFactor.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
  await db.account.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
  if (world)
    await db.organization.deleteMany({ where: { id: { in: [world.orgId, world.emptyOrgId] } } });
  await db?.$disconnect();
});

// ----------------------------------------------------------------------------------- billing

interface PlansJson {
  pricing: {
    available: boolean;
    plans: Array<{ prices: Record<string, { unitAmountPence: number | null } | undefined> }>;
    topUps?: Array<{ unitAmountPence: number | null }>;
  };
}

test.describe('billing pages', () => {
  /** Stripe is a placeholder here, so give the plans and packs amounts in the browser. */
  async function mockAmounts(page: Page): Promise<void> {
    // The server asks Stripe for prices (slow with a placeholder key): ask once, then answer from
    // memory so a page reload does not wait for it again.
    let cached: PlansJson | undefined;
    await page.route('**/api/studio/billing/plans', async (route) => {
      cached ??= (await (await route.fetch()).json()) as PlansJson;
      const json = structuredClone(cached);
      json.pricing.available = true;
      json.pricing.plans.forEach((plan, i) => {
        for (const [interval, price] of Object.entries(plan.prices)) {
          if (price) price.unitAmountPence = (i + 1) * 1_000 * (interval === 'year' ? 10 : 1);
        }
      });
      json.pricing.topUps?.forEach((pack, i) => (pack.unitAmountPence = (i + 1) * 500));
      await route.fulfill({ status: 200, contentType: 'application/json', json });
    });
  }

  /** The billing overview as the app sees it with Stripe configured (test mode). */
  async function mockStripeOn(page: Page, extra: Record<string, unknown> = {}): Promise<void> {
    await page.route(
      (url) => url.pathname === '/api/studio/billing',
      async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const res = await route.fetch();
        const json = (await res.json()) as Record<string, unknown>;
        const target = (json.billing as Record<string, unknown> | undefined) ?? json;
        Object.assign(target, { checkoutEnabled: true }, extra);
        return route.fulfill({ response: res, json });
      },
    );
  }

  test('the current plan, usage meters and an empty invoice list', async () => {
    test.setTimeout(120_000);
    const w = watch(owner);
    await w.visit('/settings/billing');
    await expect(owner.getByRole('heading', { name: 'Billing', level: 1 })).toBeVisible();
    await expect(owner.getByText('Standard plan', { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(owner.getByText('Active', { exact: true })).toBeVisible();
    await expect(owner.getByRole('meter', { name: /Short videos/ })).toBeVisible();
    await expect(owner.getByRole('meter', { name: 'Seats' })).toBeVisible();
    await expect(owner.getByRole('heading', { name: 'Top-ups' })).toBeVisible();
    await expect(owner.getByText('No invoices yet.')).toBeVisible();
    expect(w.issues).toEqual([]);
  });

  test('the plan picker lists three plans and the annual toggle changes every price', async () => {
    await mockAmounts(owner);
    const w = watch(owner);
    w.expect4xx(/\/api\/studio\/billing\//, 400, 402, 409, 500, 501, 502, 503);
    await w.visit('/settings/billing');
    const picker = owner
      .getByRole('list')
      .filter({ has: owner.getByRole('listitem', { name: 'Plus' }) });
    for (const name of ['Basic', 'Standard', 'Plus']) {
      await expect(picker.getByRole('listitem', { name })).toBeVisible();
    }
    const prices = () => picker.getByText(/£\d/).allInnerTexts();
    const monthly = await prices();
    expect(monthly.length).toBeGreaterThanOrEqual(3);
    await owner.getByRole('radio', { name: 'Annual' }).check({ force: true });
    await expect(owner.getByRole('radio', { name: 'Annual' })).toBeChecked();
    const annual = await prices();
    expect(annual).not.toEqual(monthly);
  });

  test('buying a top-up asks checkout for a top-up and returns with a thank-you', async () => {
    await mockAmounts(owner);
    await mockStripeOn(owner);
    let asked: { kind?: string } = {};
    await owner.route('**/api/studio/billing/checkout', async (route) => {
      asked = route.request().postDataJSON() as { kind?: string };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: `${baseURL}/settings/billing?topup=success` }),
      });
    });
    await owner.goto('/settings/billing');
    const buy = owner.getByRole('button', { name: /^Buy/ }).first();
    await expect(buy).toBeEnabled();
    await buy.click();
    await expect(owner).toHaveURL(/topup=success/);
    expect(asked.kind).toBe('topup');
    await expect(owner.getByText('Top-up bought.').first()).toBeVisible();
    await owner.getByRole('button', { name: 'Dismiss' }).click();
    await expect(owner.getByText('Top-up bought.')).toHaveCount(0);
  });

  test('"Manage billing" opens the Stripe portal address the server returns (test mode)', async () => {
    await mockStripeOn(owner, { hasBillingAccount: true });
    let posted = 0;
    await owner.route('**/api/studio/billing/portal', async (route) => {
      posted += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: `${baseURL}/settings/billing?portal=returned` }),
      });
    });
    await owner.goto('/settings/billing');
    await owner.getByRole('button', { name: 'Manage billing' }).click();
    await expect(owner).toHaveURL(/portal=returned/);
    expect(posted).toBe(1);
  });
});

// ------------------------------------------------------------------------------- drip queue

test.describe('calendar drip queue', () => {
  test('set a weekly schedule, save it, and it is still there after a reload', async () => {
    const w = watch(owner);
    await w.visit('/calendar');
    const drip = owner.getByRole('region', { name: 'Drip queue' });
    await expect(drip).toBeVisible();
    await drip.getByRole('radio', { name: 'Times a week' }).check({ force: true });
    await drip.getByLabel('Posts a week').selectOption('3');
    await drip.getByRole('button', { name: 'Save schedule' }).click();
    await expect(owner.getByText('Drip queue saved.').first()).toBeVisible();
    await owner.reload();
    const again = owner.getByRole('region', { name: 'Drip queue' });
    await expect(again.getByRole('radio', { name: 'Times a week' })).toBeChecked();
    await expect(again.getByLabel('Posts a week')).toHaveValue('3');
    await expect(again.getByRole('list', { name: 'Next 7 days' })).toBeVisible();
    // The calendar's own notice no longer says the drip queue is off.
    await expect(owner.getByText(/The drip queue is off/)).toHaveCount(0);
    expect(w.issues).toEqual([]);
  });

  test('back to a daily schedule: posts a day, and a day can be skipped', async () => {
    await owner.goto('/calendar');
    const drip = owner.getByRole('region', { name: 'Drip queue' });
    // Wait for the saved schedule to load (weekly, from the test above) before changing it.
    await expect(drip.getByRole('radio', { name: 'Times a week' })).toBeChecked();
    await drip.getByRole('radio', { name: 'Every day' }).check({ force: true });
    await drip.getByLabel('Posts a day').selectOption('2');
    await drip.getByRole('checkbox', { name: 'Sunday' }).uncheck({ force: true });
    await expect(drip.getByRole('checkbox', { name: 'Sunday' })).not.toBeChecked();
    await drip.getByRole('button', { name: 'Save schedule' }).click();
    await expect(owner.getByText('Drip queue saved.').first()).toBeVisible();
    const res = await owner.request.get(`/api/studio/businesses/${world.businessId}/drip-queue`);
    expect(res.ok()).toBe(true);
    const body = JSON.stringify(await res.json());
    expect(body).toContain('"postsPerDay":2');
  });
});

// ------------------------------------------------------------------------------ Admin Centre

test.describe('Admin Centre', () => {
  test('every tab loads without an error banner', async () => {
    test.setTimeout(240_000);
    const w = watch(staff);
    // Staff have no organisation: the workspace endpoints behind the shell answer 403.
    w.expect4xx(/[/]api[/]studio[/]/, 403);
    await w.visit('/admin');
    await expect(staff.getByRole('heading', { name: 'Admin Centre' })).toBeVisible();
    const tabs = (await staff.getByRole('tab').allInnerTexts()).map((t) => t.trim());
    expect(tabs).toEqual(
      expect.arrayContaining([
        'Kill switch',
        'Features',
        'Re-drive',
        'Library',
        'Cost report',
        'Queues',
        'Providers',
        'Organisations',
        'Users',
        'Subscriptions',
        'Dead letters',
        'Billing',
      ]),
    );
    for (const name of tabs) {
      w.label(`/admin ${name}`);
      await staff.getByRole('tab', { name, exact: true }).click();
      await expect(staff.getByRole('tabpanel', { name })).toBeVisible();
      await w.settle();
      await w.check();
    }
    expect(w.issues).toEqual([]);
  });

  test('cost caps: today’s caps, the tier table and the project-budget rule are shown', async () => {
    await staff.goto('/admin');
    await staff.getByRole('tab', { name: 'Cost report' }).click();
    const panel = staff.getByRole('tabpanel', { name: 'Cost report' });
    await expect(panel.getByRole('heading', { name: /Caps today/ })).toBeVisible();
    const table = panel.getByRole('table', { name: 'Organisation caps by plan tier' });
    for (const tier of ['basic', 'standard', 'plus', 'enterprise']) {
      await expect(table.getByRole('row', { name: new RegExp(tier, 'i') })).toBeVisible();
    }
    await expect(panel.getByRole('meter', { name: 'Global daily cap used' })).toBeVisible();
    await expect(panel.getByText(/Projects pause at 90%/)).toBeVisible();
  });

  test('Organisations -> Open -> plan override, and End the trial now', async () => {
    test.setTimeout(180_000);
    const orgId = `p2-trial-${run}-${randomUUID().slice(0, 4)}`;
    const started = new Date();
    await db.organization.create({ data: { id: orgId, name: `P2 Trial ${run}`, slug: orgId } });
    await db.orgEntitlement.create({
      data: {
        organisationId: orgId,
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
    const w = watch(staff);
    w.expect4xx(/[/]api[/]studio[/]/, 403);
    await w.visit('/admin');
    await staff.getByRole('tab', { name: 'Organisations' }).click();
    await staff.getByLabel('Search organisations').fill(`P2 Trial ${run}`);
    await staff.getByRole('button', { name: 'Search' }).click();
    await staff.getByRole('button', { name: `Open P2 Trial ${run}` }).click();
    await expect(staff.getByText('Running: the trial’s caps apply now.')).toBeVisible();
    const form = staff.getByRole('form', { name: 'Set an override' });
    // A reason is required.
    await form.getByLabel('Tier').selectOption('PLUS');
    await form.getByRole('checkbox', { name: 'End the trial now' }).check();
    await form.getByRole('button', { name: 'Save override' }).click();
    await expect(staff.getByRole('dialog')).toHaveCount(0);
    expect(
      (await db.orgEntitlement.findUniqueOrThrow({ where: { organisationId: orgId } })).source,
    ).toBe('trial');
    await form.getByLabel('Reason (required)').fill('QA pass 2: end the trial');
    await form.getByRole('button', { name: 'Save override' }).click();
    await staff.getByRole('dialog').getByRole('button', { name: 'Yes, save' }).click();
    await expect(staff.getByText(/Ended by staff on/)).toBeVisible();
    await expect
      .poll(
        async () =>
          (await db.orgEntitlement.findUniqueOrThrow({ where: { organisationId: orgId } })).source,
      )
      .toBe('admin');
    const stored = await db.orgEntitlement.findUniqueOrThrow({ where: { organisationId: orgId } });
    expect(stored.tier).toBe('PLUS');
    await w.settle();
    await w.check();
    expect(w.issues).toEqual([]);
  });
});
