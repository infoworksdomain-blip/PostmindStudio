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
import { BillingMock, dueNowPence, gbp, longDate, PRORATION_DATE } from './billing.mocks';
import { baseURL, noHorizontalScroll, staffPage, watch } from './pass2.support';

// 20.31 (QA pass 2) / 21.5 — the per-channel plan: /pricing (channel stepper, how often you pay,
// the free-trial link) and Your plan (headline, change with a preview applied now or at the end
// of the period, video packs, cancel and keep, the Stripe portal link, 375 px), the calendar's
// drip queue, and the Admin Centre (every section loads; Organisations -> Open -> plan override and
// "End the trial now"; cost caps — staff screens keep the internal tier names). Stripe is never
// called: the Your-plan endpoints are answered in the browser (billing.mocks.ts), and the
// placeholder Stripe keys cannot reach it.

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
  const made = await staffPage(browser, request, db, undefined, 'billing');
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

// ------------------------------------------------------------------------- pricing (public)

test.describe('public pricing', () => {
  test('/pricing: the channel stepper, the period switch and the free-trial link', async ({
    browser,
  }) => {
    // Server-rendered from the pricing source: with the placeholder Stripe key every amount reads
    // "Price unavailable"; the stepper, period, videos included and the link do not need prices.
    const context = await browser.newContext({ baseURL, locale: 'en-GB' });
    const page = await context.newPage();
    const w = watch(page);
    // Signed out: the session probes answer 401 (as in the sweep's signed-out pass).
    w.expect4xx(/\/api\/studio\/me\b/, 401, 403);
    w.expect4xx(/\/api\/auth\/get-session/, 401);
    await w.visit('/pricing');
    await expect(
      page.getByRole('heading', { name: 'One simple plan: pay per channel', level: 1 }),
    ).toBeVisible();
    // One plan: no tier cards and no tier names.
    await expect(page.getByRole('button', { name: /^Choose (Basic|Standard|Plus)/ })).toHaveCount(
      0,
    );
    await expect(page.getByText(/^(Basic|Standard|Plus|Enterprise)( plan)?$/)).toHaveCount(0);

    const plan = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Build your plan' }) })
      .last();
    const more = plan.getByRole('button', { name: 'Add a channel' });
    const fewer = plan.getByRole('button', { name: 'Remove a channel' });
    const period = plan.getByRole('radiogroup', { name: 'How often you pay' });
    // Default: 3 channels, monthly.
    await expect(plan.getByText('3 channels', { exact: true })).toBeVisible();
    await expect(period.getByRole('radio', { name: 'Monthly' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(plan.getByText('24 videos a month included (8 per channel)')).toBeVisible();
    await expect(
      plan
        .getByText(/^£\d+\.\d{2} a month$/)
        .or(plan.getByText('Price unavailable'))
        .first(),
    ).toBeVisible();
    if (await plan.getByText(/^£\d+\.\d{2} a month$/).count()) {
      // With Stripe prices: the total is the per-channel price times the channels.
      const totalText = await plan.getByText(/^£\d+\.\d{2} a month$/).innerText();
      const perText = await plan.getByText(/per channel a month/).innerText();
      const pounds = (s: string) => Number(/£([\d,.]+)/.exec(s)?.[1]?.replace(/,/g, '') ?? NaN);
      expect(pounds(totalText)).toBeCloseTo(pounds(perText) * 3, 2);
    }

    // The stepper stops at 1 and 6.
    await more.click();
    await expect(plan.getByText('4 channels', { exact: true })).toBeVisible();
    await expect(plan.getByText('32 videos a month included (8 per channel)')).toBeVisible();
    // 4 → 6: two more clicks; a third would hit the (correctly) disabled button at the maximum.
    for (let i = 0; i < 2; i += 1) await more.click();
    await expect(plan.getByText('6 channels', { exact: true })).toBeVisible();
    await expect(more).toBeDisabled();
    for (let i = 0; i < 5; i += 1) await fewer.click();
    await expect(plan.getByText('1 channel', { exact: true })).toBeVisible();
    await expect(fewer).toBeDisabled();
    await more.click();
    await expect(plan.getByText('2 channels', { exact: true })).toBeVisible();

    // Weekly costs more and says so; yearly counts the year's videos.
    await period.getByRole('radio', { name: 'Weekly' }).click();
    await expect(period.getByRole('radio', { name: 'Weekly' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(plan.getByText('4 videos a week included (2 per channel)')).toBeVisible();
    await expect(plan.getByText(/Weekly costs more than monthly/)).toBeVisible();
    await period.getByRole('radio', { name: 'Yearly' }).click();
    await expect(
      plan.getByText('192 videos a year included (8 per channel each month)'),
    ).toBeVisible();
    await expect(plan.getByText(/Weekly costs more than monthly/)).toHaveCount(0);

    // The HD video packs.
    const packs = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Need more videos?' }) })
      .last();
    await expect(packs.getByText('5 HD videos', { exact: true })).toBeVisible();
    await expect(packs.getByText('15 HD videos', { exact: true })).toBeVisible();

    // "Start free trial" (or "Get started" without a trial) carries the choice through sign-up.
    const start = plan.getByRole('link', { name: /Start free trial|Get started/ });
    const next = encodeURIComponent('/settings/billing?channels=2&interval=year');
    await expect(start).toHaveAttribute('href', `/sign-up?next=${next}`);
    await start.click();
    await expect(page).toHaveURL(/\/sign-up\?next=/);
    expect(new URL(page.url()).searchParams.get('next')).toBe(
      '/settings/billing?channels=2&interval=year',
    );
    await w.check('/pricing');
    expect(w.issues).toEqual([]);
    await context.close();
  });
});

// ----------------------------------------------------------------------------------- Your plan

test.describe('Your plan', () => {
  const plan = (page: Page) => ({
    change: page.locator('#change'),
    packs: page.locator('#topups'),
    // 25.12: the danger zone at the end of the page (and "Your plan is ending" while cancelling).
    cancel: page.locator('#cancel-plan'),
    toast: (text: string | RegExp) => page.locator('[data-sonner-toast]').filter({ hasText: text }),
  });

  test('3 channels monthly: the headline, videos, channels, packs and no cost figures', async () => {
    test.setTimeout(120_000);
    const mock = new BillingMock({ channels: 3, interval: 'month' }, baseURL);
    await mock.install(owner);
    const w = watch(owner);
    await w.visit('/settings/billing');
    await expect(owner.getByRole('heading', { name: 'Your plan', level: 1 })).toBeVisible();
    await expect(owner.getByText('3 channels, monthly', { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(owner.getByText('Active', { exact: true })).toBeVisible();
    // The plan summary's price line (the change picker below repeats the bare total).
    await expect(owner.getByText(`${gbp(8_700)} a month · excl. VAT`)).toBeVisible();
    await expect(owner.getByText(`Renews on ${longDate(mock.periodEnd)}.`)).toBeVisible();
    await expect(owner.getByRole('heading', { name: 'Videos this month' })).toBeVisible();
    await expect(owner.getByRole('heading', { name: 'Your channels' })).toBeVisible();
    await expect(owner.getByText('Your plan publishes to 3 channels.')).toBeVisible();
    await expect(owner.getByText('Publishing to: TikTok.')).toBeVisible();
    await expect(owner.getByRole('heading', { name: 'Change your plan' })).toBeVisible();
    await expect(owner.getByRole('heading', { name: 'Video packs' })).toBeVisible();
    await expect(owner.getByRole('heading', { name: 'Team and storage' })).toBeVisible();
    await expect(owner.getByRole('meter', { name: 'Seats' })).toBeVisible();
    await expect(owner.getByRole('heading', { name: 'Payment method and invoices' })).toBeVisible();
    await expect(owner.getByText('No invoices yet.')).toBeVisible();
    // 21.5: no generation cost, no tier names, no old controls.
    await expect(owner.getByText('Generation spend')).toHaveCount(0);
    await expect(owner.getByText(/^(Basic|Standard|Plus|Enterprise) plan$/)).toHaveCount(0);
    await expect(owner.getByRole('button', { name: 'Manage billing' })).toHaveCount(0);
    await expect(owner.getByRole('radio', { name: 'Annual' })).toHaveCount(0);
    // The settings sub-navigation calls it "Your plan" (25.12).
    await expect(owner.getByRole('link', { name: 'Your plan', exact: true }).first()).toBeVisible();
    expect(w.issues).toEqual([]);
  });

  test('add a channel: the preview applies now, and confirming posts the change', async () => {
    const mock = new BillingMock({ channels: 3, interval: 'month' }, baseURL);
    await mock.install(owner);
    await owner.goto('/settings/billing');
    const { change, toast } = plan(owner);
    const review = change.getByRole('button', { name: 'Review change' });
    await expect(review).toBeDisabled();
    await change.getByRole('button', { name: 'Add a channel' }).click();
    await expect(change.getByText('4 channels', { exact: true })).toBeVisible();
    const due = gbp(
      dueNowPence({ channels: 3, interval: 'month' }, { channels: 4, interval: 'month' }),
    );
    await expect(
      change.getByText(
        `New price: ${gbp(11_600)} a month. Applies now: you pay ${due} today for the rest of this period.`,
      ),
    ).toBeVisible();
    expect(mock.sent('GET', '/billing/plan/preview').at(-1)?.query).toEqual({
      channels: '4',
      interval: 'month',
    });
    await review.click();
    const dialog = owner.getByRole('dialog', { name: 'Confirm your new plan' });
    await expect(dialog.getByText('Now: 3 channels, monthly')).toBeVisible();
    await expect(dialog.getByText('New: 4 channels, monthly')).toBeVisible();
    await dialog.getByRole('button', { name: `Pay ${due} and change` }).click();
    await expect(toast('Your plan has been changed.')).toBeVisible();
    expect(mock.sent('POST', '/billing/plan')).toHaveLength(1);
    expect(mock.sent('POST', '/billing/plan')[0]?.body).toEqual({
      channels: 4,
      interval: 'month',
      prorationDate: PRORATION_DATE,
    });
    await expect(owner.getByText('4 channels, monthly', { exact: true })).toBeVisible();
    await expect(owner.getByText(`${gbp(11_600)} a month · excl. VAT`)).toBeVisible();
  });

  test('fewer channels: the preview says nothing to pay now; the change waits, then is undone', async () => {
    const mock = new BillingMock({ channels: 3, interval: 'month' }, baseURL);
    await mock.install(owner);
    await owner.goto('/settings/billing');
    const { change, toast } = plan(owner);
    await change.getByRole('button', { name: 'Remove a channel' }).click();
    const date = longDate(mock.periodEnd);
    await expect(
      change.getByText(`New price: ${gbp(5_800)} a month. Applies on ${date}. Nothing to pay now.`),
    ).toBeVisible();
    await change.getByRole('button', { name: 'Review change' }).click();
    const dialog = owner.getByRole('dialog', { name: 'Confirm your new plan' });
    await expect(dialog.getByText('New: 2 channels, monthly')).toBeVisible();
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(toast('Done. Your plan changes at the end of this period.')).toBeVisible();
    expect(mock.sent('POST', '/billing/plan')[0]?.body).toEqual({
      channels: 2,
      interval: 'month',
      prorationDate: null,
    });
    // Still 3 channels until then; the waiting change is shown and can be dropped.
    await expect(owner.getByText('3 channels, monthly', { exact: true })).toBeVisible();
    await expect(owner.getByText(`From ${date}: 2 channels, monthly.`)).toBeVisible();
    await owner.getByRole('button', { name: 'Keep my current plan' }).click();
    await expect(toast('You’ll stay on your current plan.')).toBeVisible();
    expect(mock.sent('DELETE', '/billing/plan/scheduled')).toHaveLength(1);
    await expect(owner.getByText(`From ${date}: 2 channels, monthly.`)).toHaveCount(0);

    // A shorter period waits for the end of the period too.
    await change.getByRole('radio', { name: 'Weekly' }).click();
    await expect(change.getByText(/Applies on .*\. Nothing to pay now\./)).toBeVisible();
    await change.getByRole('button', { name: 'Start again' }).click();
    await expect(change.getByRole('button', { name: 'Review change' })).toBeDisabled();
  });

  test('buy a video pack: checkout for the pack, back with a thank-you', async () => {
    const mock = new BillingMock({ channels: 3, interval: 'month' }, baseURL);
    await mock.install(owner);
    await owner.goto('/settings/billing');
    const { packs } = plan(owner);
    await expect(packs.getByText('5 HD videos', { exact: true })).toBeVisible();
    await expect(packs.getByText('15 HD videos', { exact: true })).toBeVisible();
    await expect(
      packs.getByRole('button', { name: `Buy 15 HD videos for ${gbp(3_900)}` }),
    ).toBeEnabled();
    await packs.getByRole('button', { name: `Buy 5 HD videos for ${gbp(1_500)}` }).click();
    await expect(owner).toHaveURL(/topup=success/);
    expect(mock.sent('POST', '/billing/checkout')[0]?.body).toMatchObject({
      kind: 'topup',
      lookupKey: 'studio_pack_hd5',
      locale: expect.any(String),
    });
    const banner = owner.getByRole('status').filter({ hasText: 'Video pack bought.' });
    await expect(banner).toBeVisible();
    await owner.getByRole('button', { name: 'Dismiss' }).click();
    await expect(banner).toHaveCount(0);
  });

  test('cancel the plan, then keep it', async () => {
    const mock = new BillingMock({ channels: 3, interval: 'month' }, baseURL);
    await mock.install(owner);
    await owner.goto('/settings/billing');
    const { cancel, change, toast } = plan(owner);
    const date = longDate(mock.periodEnd);
    await cancel.getByRole('button', { name: 'Cancel plan' }).click();
    const dialog = owner.getByRole('alertdialog', { name: 'Cancel your plan?' });
    await expect(dialog).toContainText(`Your plan will end on ${date}.`);
    // "Keep my plan" in the dialog changes nothing.
    await dialog.getByRole('button', { name: 'Keep my plan', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(mock.sent('POST', '/billing/plan/cancel')).toHaveLength(0);
    await cancel.getByRole('button', { name: 'Cancel plan' }).click();
    await owner
      .getByRole('alertdialog', { name: 'Cancel your plan?' })
      .getByRole('button', { name: 'Cancel plan' })
      .click();
    await expect(toast('Your plan will end at the end of this period.')).toBeVisible();
    expect(mock.sent('POST', '/billing/plan/cancel')).toHaveLength(1);
    await expect(owner.getByText('Cancelling', { exact: true })).toBeVisible();
    await expect(
      cancel.getByText(`Your plan ends on ${date}. You keep full access until then.`),
    ).toBeVisible();
    // While cancelling, the plan cannot be changed.
    await expect(
      change.getByText('Your plan is set to end. Keep your plan first, then you can change it.'),
    ).toBeVisible();
    await cancel.getByRole('button', { name: 'Keep my plan', exact: true }).click();
    await expect(toast('Your plan will continue.')).toBeVisible();
    expect(mock.sent('POST', '/billing/plan/resume')).toHaveLength(1);
    await expect(owner.getByText('Active', { exact: true })).toBeVisible();
    await expect(cancel.getByRole('button', { name: 'Cancel plan' })).toBeVisible();
  });

  test('"Open billing portal" goes to the Stripe portal address the server returns', async () => {
    const mock = new BillingMock({ channels: 3, interval: 'month' }, baseURL);
    await mock.install(owner);
    await owner.goto('/settings/billing');
    await owner.getByRole('button', { name: 'Open billing portal' }).click();
    await expect(owner).toHaveURL(/portal=returned/);
    expect(mock.sent('POST', '/billing/portal')).toHaveLength(1);
  });

  test('at 375 px Your plan fits the screen and its buttons work with a thumb', async ({
    browser,
  }) => {
    const phone = await signedInPage(browser, baseURL, emailFor('p2-billing'), {
      viewport: { width: 375, height: 812 },
    });
    const mock = new BillingMock({ channels: 3, interval: 'month' }, baseURL);
    await mock.install(phone);
    const w = watch(phone);
    await w.visit('/settings/billing');
    await expect(phone.getByText('3 channels, monthly', { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    expect(await noHorizontalScroll(phone), '/settings/billing scrolls sideways').toBe(true);
    const { change, packs, cancel } = plan(phone);
    await change.getByRole('button', { name: 'Add a channel' }).click();
    await expect(change.getByText(/Applies now: you pay/)).toBeVisible();
    const review = change.getByRole('button', { name: 'Review change' });
    await review.scrollIntoViewIfNeeded();
    await expect(review).toBeInViewport({ ratio: 1 });
    await expect(review).toBeEnabled();
    await expect(packs.getByRole('button', { name: /^Buy 5 HD videos/ })).toBeVisible();
    await expect(cancel.getByRole('button', { name: 'Cancel plan' })).toBeVisible();
    expect(await noHorizontalScroll(phone), 'the preview widens the page').toBe(true);
    await w.check('/settings/billing 375');
    expect(w.issues).toEqual([]);
    await phone.context().close();
  });
});

// ------------------------------------------------------------------------------- drip queue

test.describe('calendar drip queue', () => {
  test('set a weekly schedule, save it, and it is still there after a reload', async () => {
    const w = watch(owner);
    await w.visit('/calendar');
    // 25.9: the posting times (drip queue) open in a side sheet from the calendar header.
    await owner.getByRole('button', { name: 'Posting times', exact: true }).click();
    const drip = owner.getByRole('region', { name: 'Drip queue' });
    await expect(drip).toBeVisible();
    await drip.getByRole('radio', { name: 'Times a week' }).click();
    await drip.getByLabel('Posts a week').selectOption('3');
    await drip.getByRole('button', { name: 'Save schedule' }).click();
    await expect(owner.getByText('Drip queue saved.').first()).toBeVisible();
    await owner.reload();
    await owner.getByRole('button', { name: 'Posting times', exact: true }).click();
    const again = owner.getByRole('region', { name: 'Drip queue' });
    await expect(again.getByRole('radio', { name: 'Times a week' })).toBeChecked();
    await expect(again.getByLabel('Posts a week')).toHaveValue('3');
    await expect(again.getByRole('list', { name: 'Next 7 days' })).toBeVisible();
    // The calendar's own notice no longer says the drip queue is off.
    await owner.keyboard.press('Escape');
    await expect(owner.getByText(/The drip queue is off/)).toHaveCount(0);
    expect(w.issues).toEqual([]);
  });

  test('back to a daily schedule: posts a day, and a day can be skipped', async () => {
    await owner.goto('/calendar');
    await owner.getByRole('button', { name: 'Posting times', exact: true }).click();
    const drip = owner.getByRole('region', { name: 'Drip queue' });
    // Wait for the saved schedule to load (weekly, from the test above) before changing it.
    await expect(drip.getByRole('radio', { name: 'Times a week' })).toBeChecked();
    await drip.getByRole('radio', { name: 'Every day' }).click();
    await drip.getByLabel('Posts a day').selectOption('2');
    await drip.getByRole('checkbox', { name: 'Sunday' }).click();
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
  test('every section loads without an error banner', async () => {
    test.setTimeout(240_000);
    const w = watch(staff);
    // Staff have no organisation: the workspace endpoints behind the shell answer 403.
    w.expect4xx(/[/]api[/]studio[/]/, 403);
    await w.visit('/admin');
    await expect(staff.getByRole('heading', { name: 'Admin Centre' })).toBeVisible();
    // 25.13: a sectioned side menu replaces the tab row; it renders once the staff access probe
    // answers, after the heading.
    const menu = staff.getByRole('navigation', { name: 'Admin sections' });
    await expect(menu.getByRole('link', { name: 'Kill switch', exact: true })).toBeVisible();
    const sections = (await menu.getByRole('link').allInnerTexts()).map((t) => t.trim());
    expect(sections).toEqual(
      expect.arrayContaining([
        'Kill switch',
        'Queues',
        'Dead letters',
        'Re-drive',
        'Providers',
        'Library',
        'Organisations',
        'Users',
        'Subscriptions & billing',
        'Features',
        'Cost report',
      ]),
    );
    for (const name of sections) {
      w.label(`/admin ${name}`);
      await menu.getByRole('link', { name, exact: true }).click();
      await expect(staff.getByRole('region', { name, exact: true })).toBeVisible();
      await w.settle();
      await w.check();
    }
    // The section is in the URL: a reload keeps it.
    await staff.reload();
    await expect(staff.getByRole('region', { name: 'Cost report', exact: true })).toBeVisible();
    expect(new URL(staff.url()).searchParams.get('tab')).toBe('cost');
    expect(w.issues).toEqual([]);
  });

  test('cost caps: today’s caps, the tier table and the project-budget rule are shown', async () => {
    await staff.goto('/admin?tab=cost');
    const panel = staff.getByRole('region', { name: 'Cost report', exact: true });
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
    await staff
      .getByRole('navigation', { name: 'Admin sections' })
      .getByRole('link', { name: 'Organisations' })
      .click();
    await staff.getByLabel('Search organisations').fill(`P2 Trial ${run}`);
    await staff.getByRole('button', { name: 'Search', exact: true }).click();
    await staff.getByRole('button', { name: `Open P2 Trial ${run}` }).click();
    await expect(staff.getByText('Running: the trial’s caps apply now.')).toBeVisible();
    const form = staff.getByRole('form', { name: 'Set an override' });
    // Save stays disabled until a reason is given.
    await form.getByLabel('Tier').selectOption('PLUS');
    await form.getByRole('checkbox', { name: 'End the trial now' }).check();
    await expect(form.getByRole('button', { name: 'Save override' })).toBeDisabled();
    await form.getByLabel('Reason (required)').fill('QA pass 2: end the trial');
    await form.getByRole('button', { name: 'Save override' }).click();
    await staff.getByRole('alertdialog').getByRole('button', { name: 'Yes, save' }).click();
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
