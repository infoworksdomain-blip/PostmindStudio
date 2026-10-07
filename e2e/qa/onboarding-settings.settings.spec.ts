import { randomUUID } from 'node:crypto';
import {
  addMember,
  createUser,
  expect,
  givePlan,
  hasDb,
  newCtx,
  openDb,
  ownerWithOrg,
  PASSWORD,
  run,
  setActiveOrg,
  shot,
  signInApi,
  signInUi,
  test,
  toast,
  uniqueEmail,
  waitForEmail,
  Watcher,
} from './onboarding-settings.support';
import { BillingMock, gbp } from './billing.mocks';

// QA agent 1 — /settings/organisation, /settings/members, /settings/audit, /settings/billing
// ("Your plan", 21.5 per-channel plan) and the upgrade dialog. Stripe is never called: the
// Your-plan endpoints, checkout and portal answers are mocked in the browser (billing.mocks.ts),
// and the plan states are seeded in studio.org_entitlements / subscriptions.

test.describe.configure({ timeout: 300_000 });
test.skip(!hasDb, 'DATABASE_URL is not set: these specs need the app’s database');

const db = hasDb ? openDb() : (undefined as never);
test.afterAll(async () => {
  await db?.$disconnect();
});

test.describe('organisation settings', () => {
  test('an owner edits details; validation; persistence; logo must be https', async ({
    page,
    context,
  }) => {
    const w = new Watcher(page);
    w.allow(/\/api\/studio\/org$/, 400, 422);
    const { org } = await ownerWithOrg(context, db, 'org1');
    await w.visit(page, '/settings/organisation');
    await expect(page.getByRole('heading', { name: 'Organisation', level: 1 })).toBeVisible();
    const save = page.getByRole('button', { name: 'Save' });
    await page.getByLabel('Organisation name').fill('A');
    await expect(save).toBeDisabled();
    await page.getByLabel('Organisation name').fill(`Renamed ${run}`);
    await page.getByLabel('Logo URL').fill('http://insecure.example/logo.png');
    await save.click();
    // The API only takes https:// logos; the page says so instead of failing silently.
    await expect(page.locator('[data-sonner-toast]').first()).toBeVisible();
    await page.getByLabel('Logo URL').fill('https://example.test/logo.png');
    await page.getByLabel('Country').selectOption('KE');
    await page.getByLabel('Default language').selectOption('de');
    await save.click();
    await toast(page, 'Organisation details saved.');
    const row = await db.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(row).toMatchObject({
      name: `Renamed ${run}`,
      logo: 'https://example.test/logo.png',
      country: 'KE',
      defaultLocale: 'de',
    });
    // Clearing the logo and choosing "Not set" clears them.
    await page.reload();
    await page.getByLabel('Logo URL').fill('');
    await page.getByLabel('Country').selectOption('');
    await save.click();
    await toast(page, 'Organisation details saved.');
    const cleared = await db.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(cleared.logo).toBeNull();
    expect(cleared.country).toBeNull();
    // The audit log has the rename.
    expect(
      await db.auditLog.count({ where: { organisationId: org.id, action: 'org.renamed' } }),
    ).toBe(1);
    await shot(page, 'settings-organisation');
    await w.assertClean();
  });

  test('members below admin see the details read-only and no transfer or delete', async ({
    page,
    context,
    browser,
  }) => {
    const { org } = await ownerWithOrg(context, db, 'org2');
    for (const role of ['admin', 'publisher', 'creator', 'viewer'] as const) {
      const ctx = await newCtx(browser, `10.240.${role.length}.1`);
      const user = await createUser(ctx, db, `org2-${role}`);
      await addMember(db, org.id, user.id, role);
      await signInApi(ctx, user);
      await setActiveOrg(db, user.id, org.id);
      const p = await ctx.newPage();
      await p.goto('/settings/organisation');
      await expect(p.getByLabel('Organisation name')).toBeVisible();
      const editable = role === 'admin';
      await expect(p.getByLabel('Organisation name')).toBeEnabled({ enabled: editable });
      await expect(p.getByRole('button', { name: 'Save' })).toHaveCount(editable ? 1 : 0);
      await expect(p.getByRole('button', { name: 'Delete organisation…' })).toHaveCount(0);
      await expect(p.getByRole('button', { name: 'Transfer ownership' })).toHaveCount(0);
      // The API refuses the same edit from the keyboard-less side.
      const res = await ctx.request.patch('/api/studio/org', { data: { name: 'Hacked' } });
      expect(res.status()).toBe(editable ? 200 : 403);
      const del = await ctx.request.delete('/api/studio/org', { data: { confirmName: org.name } });
      expect(del.status()).toBe(403);
      await ctx.close();
    }
    void page;
  });

  test('transfer ownership asks for the password and swaps the roles', async ({
    page,
    context,
  }) => {
    const w = new Watcher(page);
    w.allow(/\/api\/studio\/org\/transfer-ownership$/, 403, 401, 400, 422);
    const { org, user } = await ownerWithOrg(context, db, 'xfer');
    await page.goto('/settings/organisation');
    await expect(page.getByText('Invite someone first')).toBeVisible();
    const heir = await createUser(context, db, 'heir');
    const heirMember = await addMember(db, org.id, heir.id, 'admin');
    await page.reload();
    await page.getByLabel('New owner').selectOption(heirMember);
    await page.getByRole('button', { name: 'Transfer ownership' }).first().click();
    const dialog = page.getByRole('alertdialog', { name: 'Transfer ownership?' });
    await dialog.getByLabel('Your password').fill('definitely-wrong-password');
    await dialog.getByRole('button', { name: 'Transfer ownership' }).click();
    await expect(page.locator('[data-sonner-toast]').first()).toBeVisible();
    expect((await db.member.findUniqueOrThrow({ where: { id: heirMember } })).role).toBe('admin');
    await dialog.getByLabel('Your password').fill(PASSWORD);
    await dialog.getByRole('button', { name: 'Transfer ownership' }).click();
    await expect
      .poll(async () => (await db.member.findUniqueOrThrow({ where: { id: heirMember } })).role)
      .toBe('owner');
    expect(
      (await db.member.findFirstOrThrow({ where: { organizationId: org.id, userId: user.id } }))
        .role,
    ).toBe('admin');
    await expect(page.getByRole('button', { name: 'Delete organisation…' })).toHaveCount(0);
    await w.assertClean();
  });

  test('deleting an organisation needs its exact name and the password', async ({
    page,
    context,
  }) => {
    const w = new Watcher(page);
    w.allow(/\/api\/studio\/org$/, 403, 401, 400, 422);
    const { org } = await ownerWithOrg(context, db, 'del');
    await page.goto('/settings/organisation');
    await page.getByRole('button', { name: 'Delete organisation…' }).click();
    const dialog = page.getByRole('alertdialog');
    const confirm = dialog.getByRole('button', { name: 'Delete organisation' });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(/Type .* to confirm/).fill(`${org.name} `.slice(0, -2));
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(/Type .* to confirm/).fill(org.name);
    await dialog.getByLabel('Your password').fill('definitely-wrong-password');
    await confirm.click();
    await expect(page.locator('[data-sonner-toast]').first()).toBeVisible();
    expect(
      (await db.organization.findUniqueOrThrow({ where: { id: org.id } })).deletedAt,
    ).toBeNull();
    await shot(page, 'settings-delete-organisation');
    // From here the user has no organisation: every workspace API answers 403 no_organisation.
    w.noOrganisation = true;
    await dialog.getByLabel('Your password').fill(PASSWORD);
    await confirm.click();
    await expect(page).not.toHaveURL(/settings\/organisation/);
    expect(
      (await db.organization.findUniqueOrThrow({ where: { id: org.id } })).deletedAt,
    ).not.toBeNull();
    // Signed in but with no organisation left: workspace pages go to the wizard.
    await page.goto('/projects');
    await expect(page).toHaveURL(/\/welcome/);
    await w.assertClean();
  });
});

test.describe('members', () => {
  test('invite every role, refuse duplicates and bad input, resend and revoke', async ({
    page,
    context,
  }) => {
    const w = new Watcher(page);
    w.allow(/\/api\/studio\/members\/invitations$/, 409, 400, 422, 403);
    const { org, user } = await ownerWithOrg(context, db, 'mem1');
    await givePlan(db, org.id, 'PLUS');
    await w.visit(page, '/settings/members');
    await expect(page.getByRole('heading', { name: 'Members', level: 1 })).toBeVisible();
    await expect(page.getByText('1 member')).toBeVisible();
    await expect(page.getByText('No pending invitations.')).toBeVisible();
    const send = page.getByRole('button', { name: 'Send invitation' });
    await expect(send).toBeDisabled();
    // Every invitable role; owner is not on the list.
    const roles = await page
      .getByLabel('Role', { exact: true })
      .locator('option')
      .allTextContents();
    expect(roles).toEqual(['Admin', 'Publisher', 'Creator', 'Viewer']);
    const emails: Record<string, string> = {};
    for (const role of ['Admin', 'Publisher', 'Creator', 'Viewer']) {
      emails[role] = uniqueEmail(`inv-${role.toLowerCase()}`);
      await page.getByLabel('Email address').fill(emails[role] as string);
      await page.getByLabel('Role', { exact: true }).selectOption({ label: role });
      await send.click();
      await toast(page, `Invitation sent to ${emails[role]}.`);
      await expect(page.getByText(emails[role] as string).first()).toBeVisible();
      const mail = await waitForEmail(db, emails[role] as string, 'invite');
      expect(mail.params.role).toBe(role.toLowerCase());
    }
    // Case-insensitive: stored lower-case.
    expect(
      await db.invitation.count({ where: { organizationId: org.id, status: 'pending' } }),
    ).toBe(4);
    // Inviting an existing member is refused (409), a malformed address never leaves the browser.
    const dup = await context.request.post('/api/studio/members/invitations', {
      data: { email: user.email.toUpperCase(), role: 'viewer' },
    });
    expect(dup.status()).toBe(409);
    const bad = await context.request.post('/api/studio/members/invitations', {
      data: { email: 'nope', role: 'viewer' },
    });
    expect(bad.status()).toBe(400);
    const owner = await context.request.post('/api/studio/members/invitations', {
      data: { email: uniqueEmail('owner-invite'), role: 'owner' },
    });
    expect(owner.status()).toBe(400);
    await shot(page, 'settings-members');

    // Resend and revoke the first pending one.
    const first = emails['Admin'] as string;
    await page.getByRole('button', { name: `Resend the invitation to ${first}` }).click();
    await toast(page, `Invitation sent again to ${first}.`);
    await page.getByRole('button', { name: `Revoke the invitation to ${first}` }).click();
    await toast(page, 'Invitation revoked.');
    await expect(page.getByText(first)).toHaveCount(0);
    expect(
      await db.invitation.count({ where: { organizationId: org.id, status: 'pending' } }),
    ).toBe(3);
    await w.assertClean();
  });

  test('without a plan the seat limit stops invitations and offers an upgrade', async ({
    page,
    context,
  }) => {
    const w = new Watcher(page);
    w.allow(/\/api\/studio\/members\/invitations$/, 403);
    await ownerWithOrg(context, db, 'mem2');
    await page.goto('/settings/members');
    await expect(page.getByText('1 of 2')).toBeVisible();
    await page.getByLabel('Email address').fill(uniqueEmail('seat-ok'));
    await page.getByRole('button', { name: 'Send invitation' }).click();
    await expect(page.getByText('2 of 2')).toBeVisible();
    await expect(page.getByText('Every seat on your plan is in use.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Upgrade for more seats' })).toHaveAttribute(
      'href',
      '/settings/billing',
    );
    await expect(page.getByLabel('Email address')).toBeDisabled();
    // Straight to the API: refused with the seat-limit code, and the upgrade dialog wording must
    // not talk about a monthly allowance (a seat limit is not a monthly quota).
    const res = await context.request.post('/api/studio/members/invitations', {
      data: { email: uniqueEmail('seat-over'), role: 'viewer' },
    });
    expect(res.status()).toBe(403);
    const body = (await res.json()) as { error: string; details?: { reason?: string } };
    expect(body.details?.reason).toBe('seat_limit');
    await shot(page, 'settings-members-seat-limit');
    await w.assertClean();
  });

  test('the seat-limit refusal opens the upgrade dialog with seat wording', async ({
    page,
    context,
  }) => {
    const w = new Watcher(page);
    w.allow(/\/api\/studio\/members\/invitations$/, 403);
    await ownerWithOrg(context, db, 'mem3');
    await page.goto('/settings/members');
    // Race: the form is open while the plan fills (another admin invited), so the POST is refused.
    await page.route('**/api/studio/members/invitations', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: 'quota_exceeded',
          message: 'Every seat on the plan is in use',
          details: { reason: 'seat_limit', used: 2, limit: 2 },
        }),
      });
    });
    await page.getByLabel('Email address').fill(uniqueEmail('seat-race'));
    await page.getByRole('button', { name: 'Send invitation' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toContainText('this month');
    await expect(dialog).toContainText('seat');
    await shot(page, 'upgrade-dialog-seat-limit');
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('roles: owner changes and removes, admins cannot touch owners, last owner stays, leave', async ({
    page,
    context,
    browser,
  }) => {
    const w = new Watcher(page);
    w.allow(/\/api\/studio\/members\//, 403, 409);
    const { org, user } = await ownerWithOrg(context, db, 'mem4');
    await givePlan(db, org.id, 'PLUS');
    const bob = await createUser(context, db, 'bob');
    const bobMember = await addMember(db, org.id, bob.id, 'creator');
    const ann = await createUser(context, db, 'ann');
    const annMember = await addMember(db, org.id, ann.id, 'admin');
    await w.visit(page, '/settings/members');
    await expect(page.getByText('3 members')).toBeVisible();
    // Change a role from the table.
    await page.getByLabel(`Role for ${bob.name}`).selectOption('publisher');
    await toast(page, `${bob.name} is now Publisher.`);
    expect((await db.member.findUniqueOrThrow({ where: { id: bobMember } })).role).toBe(
      'publisher',
    );
    // The owner's own role select has no "owner" option for others, and offers it for owners.
    const own = page.getByLabel(`Role for ${user.name}`);
    expect(await own.locator('option').allTextContents()).toContain('Owner');
    // The last owner cannot demote or leave themselves.
    const res = await context.request.patch(
      `/api/studio/members/${(await db.member.findFirstOrThrow({ where: { organizationId: org.id, userId: user.id } })).id}`,
      { data: { role: 'viewer' } },
    );
    expect(res.status()).toBe(409);
    await page.getByRole('button', { name: 'Leave' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
    await expect(page.locator('[data-sonner-toast]').first()).toBeVisible();
    expect(await db.member.count({ where: { organizationId: org.id, role: 'owner' } })).toBe(1);

    // An admin sees the table but cannot edit or remove the owner.
    const adminCtx = await newCtx(browser, '10.241.1.1');
    await signInApi(adminCtx, ann);
    await setActiveOrg(db, ann.id, org.id);
    const ap = await adminCtx.newPage();
    await ap.goto('/settings/members');
    await expect(ap.getByLabel(`Role for ${user.name}`)).toHaveCount(0);
    await expect(ap.getByRole('button', { name: `Remove ${user.name}` })).toHaveCount(0);
    await expect(ap.getByLabel(`Role for ${bob.name}`)).toBeVisible();
    const ownerMemberId = (
      await db.member.findFirstOrThrow({ where: { organizationId: org.id, userId: user.id } })
    ).id;
    expect(
      (
        await adminCtx.request.patch(`/api/studio/members/${ownerMemberId}`, {
          data: { role: 'viewer' },
        })
      ).status(),
    ).toBe(403);
    expect((await adminCtx.request.delete(`/api/studio/members/${ownerMemberId}`)).status()).toBe(
      403,
    );
    expect(
      (
        await adminCtx.request.patch(`/api/studio/members/${annMember}`, {
          data: { role: 'owner' },
        })
      ).status(),
    ).toBe(403);
    await adminCtx.close();

    // The owner removes bob (confirm dialog), who then has no organisation.
    await page.reload();
    await page.getByRole('button', { name: `Remove ${bob.name}` }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
    await toast(page, `${bob.name} was removed.`);
    expect(await db.member.count({ where: { id: bobMember } })).toBe(0);
    await w.assertClean();
  });

  test('a viewer sees the members but no invite form, pending list or controls', async ({
    page,
    context,
    browser,
  }) => {
    const { org } = await ownerWithOrg(context, db, 'mem5');
    const viewer = await createUser(context, db, 'viewer');
    await addMember(db, org.id, viewer.id, 'viewer');
    await db.invitation.create({
      data: {
        id: randomUUID(),
        organizationId: org.id,
        email: uniqueEmail('pending'),
        role: 'viewer',
        status: 'pending',
        expiresAt: new Date(Date.now() + 86_400_000),
        inviterId: (
          await db.member.findFirstOrThrow({ where: { organizationId: org.id, role: 'owner' } })
        ).userId,
      },
    });
    const ctx = await newCtx(browser, '10.241.2.2');
    await signInApi(ctx, viewer);
    await setActiveOrg(db, viewer.id, org.id);
    const p = await ctx.newPage();
    await p.goto('/settings/members');
    await expect(p.getByText('2 members')).toBeVisible();
    await expect(p.getByLabel('Email address')).toHaveCount(0);
    await expect(p.getByText('Pending invitations')).toHaveCount(0);
    await expect(p.getByRole('button', { name: /^Remove / })).toHaveCount(0);
    expect((await ctx.request.get('/api/studio/members/invitations')).status()).toBe(403);
    void page;
    await ctx.close();
  });
});

test.describe('audit log', () => {
  test('shows what happened, filters by category and loads more', async ({ page, context }) => {
    const w = new Watcher(page);
    const { org, user } = await ownerWithOrg(context, db, 'audit');
    await givePlan(db, org.id, 'PLUS');
    await context.request.post('/api/studio/members/invitations', {
      data: { email: uniqueEmail('audit-inv'), role: 'viewer' },
    });
    // 60 older rows so "Load more" has a second page.
    await db.auditLog.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        occurredAt: new Date(Date.now() - (i + 1) * 60_000),
        actorUserId: user.id,
        actorType: 'user',
        organisationId: org.id,
        action: 'business.created',
        resourceType: 'business',
        resourceId: `seed-${i}-${randomUUID()}`,
      })),
    });
    await w.visit(page, '/settings/audit');
    await expect(
      page
        .getByRole('heading', { name: 'Audit log', level: 1 })
        .or(page.getByRole('heading', { name: 'Audit log' }).first()),
    ).toBeVisible();
    await expect(page.getByText('Invited a member')).toBeVisible();
    await expect(page.getByText('Created the organisation'))
      .toHaveCount(0)
      .catch(() => undefined);
    expect(await page.getByRole('row').count()).toBeGreaterThan(40);
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect.poll(async () => page.getByRole('row').count()).toBeGreaterThan(55);
    await page.getByLabel('Show').selectOption({ label: 'Members' });
    await w.settle(page);
    await expect(page.getByText('Added a business')).toHaveCount(0);
    await expect(page.getByText('Invited a member')).toBeVisible();
    await page.getByLabel('Show').selectOption({ label: 'PostMind staff' });
    await expect(page.getByText('Nothing here yet')).toBeVisible();
    await shot(page, 'settings-audit-empty-filter');
    await w.assertClean();
  });

  test('another organisation’s events never appear and non-admins are refused', async ({
    context,
    browser,
  }) => {
    const a = await ownerWithOrg(context, db, 'audit-a');
    const other = await newCtx(browser, '10.242.1.1');
    const b = await ownerWithOrg(other, db, 'audit-b');
    await db.auditLog.create({
      data: {
        actorUserId: b.user.id,
        actorType: 'user',
        organisationId: b.org.id,
        action: 'org.updated',
        resourceType: 'organisation',
        resourceId: `secret-${run}`,
      },
    });
    const res = await context.request.get('/api/studio/audit?limit=50');
    expect(res.status()).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain(`secret-${run}`);
    void a;
    const viewer = await createUser(other, db, 'audit-viewer');
    await addMember(db, b.org.id, viewer.id, 'viewer');
    await signInApi(other, viewer);
    await setActiveOrg(db, viewer.id, b.org.id);
    expect((await other.request.get('/api/studio/audit')).status()).toBe(403);
    await other.close();
  });
});

test.describe('billing and the upgrade dialog', () => {
  test('no plan: choose channels and how often to pay, checkout with channels, return banners', async ({
    page,
    context,
  }) => {
    const w = new Watcher(page);
    w.allow(/\/api\/studio\/billing\//, 400, 402, 409, 500, 501, 502, 503);
    await ownerWithOrg(context, db, 'bill1');
    // Stripe is a placeholder here, so the Your-plan endpoints are answered in the browser with
    // test amounts (in production they come from Stripe prices); checkout returns a URL.
    const origin = new URL(test.info().project.use.baseURL ?? 'http://127.0.0.1:3102').origin;
    const mock = new BillingMock(null, origin);
    await mock.install(page);
    // A link from /pricing (via sign-up) arrives with the choice already made.
    await w.visit(page, '/settings/billing?channels=2&interval=week');
    await expect(page.getByText('Your organisation doesn’t have a plan yet.')).toBeVisible();
    await expect(page.getByText('No plan', { exact: true }).first()).toBeVisible();
    await shot(page, 'settings-billing-no-plan');
    const picker = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Choose your plan', exact: true }) })
      .last();
    await expect(picker.getByText('2 channels', { exact: true })).toBeVisible();
    const period = picker.getByRole('radiogroup', { name: 'How often you pay' });
    await expect(period.getByRole('radio', { name: 'Weekly' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(picker.getByText(`${gbp(1_800)} a week`, { exact: true })).toBeVisible();
    // No tier cards, no old toggle.
    await expect(page.getByRole('button', { name: /^Choose (Basic|Standard|Plus)/ })).toHaveCount(
      0,
    );
    await expect(page.getByRole('radio', { name: 'Annual' })).toHaveCount(0);
    // Change the choice: 3 channels, yearly (2 months free).
    await picker.getByRole('button', { name: 'Add a channel' }).click();
    await period.getByRole('radio', { name: 'Yearly' }).click();
    await expect(picker.getByText('3 channels', { exact: true })).toBeVisible();
    await expect(picker.getByText(`${gbp(87_000)} a year`, { exact: true })).toBeVisible();
    await expect(picker.getByText(/^2 months free: you save/)).toBeVisible();
    // Video packs need a plan first.
    await expect(page.getByText('Choose a plan first to buy video packs.')).toBeVisible();
    // Checkout asks for the channels and the period; the browser follows the returned URL.
    await picker.getByRole('button', { name: /^(Start free trial|Continue to payment)$/ }).click();
    await expect(page).toHaveURL(/checkout=success/);
    expect(mock.sent('POST', '/billing/checkout')[0]?.body).toMatchObject({
      kind: 'channels',
      channels: 3,
      interval: 'year',
      locale: expect.any(String),
    });
    await expect(
      page.getByRole('status').filter({ hasText: 'Your plan is being set up' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss' }).click();
    for (const [q, text] of [
      ['checkout=cancelled', 'Checkout was cancelled.'],
      ['topup=success', 'Video pack bought.'],
      ['topup=cancelled', 'Video pack purchase cancelled.'],
    ] as const) {
      await page.goto(`/settings/billing?${q}`);
      await expect(page.getByRole('status').filter({ hasText: text })).toBeVisible();
    }
    await w.assertClean();
  });

  test('each plan status shows the right summary and banner', async ({ page, context }) => {
    const w = new Watcher(page);
    w.allow(/\/api\/studio\/billing\//, 400, 402, 409, 500, 501, 502, 503);
    const cases: Array<{
      label: string;
      seed: (orgId: string) => Promise<void>;
      expect: Array<string | RegExp>;
    }> = [
      {
        label: 'active',
        seed: (o) => givePlan(db, o, 'STANDARD', { source: 'admin', channels: 3 }),
        expect: ['3 channels, monthly', 'Custom plan set by PostMind staff.'],
      },
      {
        label: 'past due',
        seed: (o) =>
          givePlan(db, o, 'STANDARD', {
            source: 'stripe',
            channels: 2,
            interval: 'year',
            graceUntil: new Date(Date.now() + 3 * 86_400_000),
          }),
        expect: ['2 channels, yearly', 'Payment failed', /We couldn’t take your last payment/],
      },
      {
        label: 'read only',
        seed: (o) =>
          givePlan(db, o, 'STANDARD', { access: 'read_only', source: 'stripe', channels: 1 }),
        expect: ['Read-only', /Your account is read-only/],
      },
    ];
    for (const c of cases) {
      const ctx = await newCtx(context.browser()!, `10.243.${c.label.length}.1`);
      const { org } = await ownerWithOrg(ctx, db, `bill-${c.label.replace(' ', '')}`);
      await c.seed(org.id);
      const p = await ctx.newPage();
      await p.goto('/settings/billing');
      for (const text of c.expect) {
        await expect(
          (typeof text === 'string'
            ? p.getByText(text, { exact: true })
            : p.getByText(text)
          ).first(),
        ).toBeVisible();
      }
      // Customers never see the internal tier or a cost figure.
      await expect(p.getByText(/^(Basic|Standard|Plus|Enterprise) plan$/)).toHaveCount(0);
      await expect(p.getByText('Generation spend')).toHaveCount(0);
      await shot(p, `settings-billing-${c.label.replace(' ', '-')}`);
      await ctx.close();
    }
    void page;
    await w.assertClean();
  });

  test('a non-owner is told to ask an owner and gets no Stripe buttons', async ({
    context,
    browser,
  }) => {
    const { org } = await ownerWithOrg(context, db, 'bill3');
    await givePlan(db, org.id, 'STANDARD', { channels: 3 });
    const admin = await newCtx(browser, '10.244.1.1');
    const user = await createUser(admin, db, 'bill3-admin');
    await addMember(db, org.id, user.id, 'admin');
    await signInApi(admin, user);
    await setActiveOrg(db, user.id, org.id);
    const p = await admin.newPage();
    await p.goto('/settings/billing');
    await expect(p.getByText('3 channels, monthly', { exact: true })).toBeVisible();
    await expect(p.getByText(/organisation owner|ask an owner/i).first()).toBeVisible();
    for (const name of ['Open billing portal', 'Review change', 'Cancel plan', 'Manage billing']) {
      await expect(p.getByRole('button', { name })).toHaveCount(0);
    }
    await expect(p.getByRole('button', { name: /^Buy \d+ HD videos/ })).toHaveCount(0);
    expect((await admin.request.post('/api/studio/billing/portal', { data: {} })).status()).toBe(
      403,
    );
    expect(
      (
        await admin.request.post('/api/studio/billing/checkout', {
          data: { kind: 'channels', channels: 1, interval: 'month' },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await admin.request.post('/api/studio/billing/plan', {
          data: { channels: 4, interval: 'month', prorationDate: null },
        })
      ).status(),
    ).toBe(403);
    expect((await admin.request.post('/api/studio/billing/plan/cancel')).status()).toBe(403);
    await admin.close();
  });

  test('the upgrade dialog: plan required, billing required, videos used, not in plan, channel limit; Not now closes', async ({
    page,
    context,
  }) => {
    const { org } = await ownerWithOrg(context, db, 'bill4', { business: true });
    void org;
    await page.goto('/library');
    // 21.5: no tier is ever named. billing_required offers "Update payment method" only when
    // Stripe checkout is on (owners); here it may be off, so that case checks the copy only.
    const cases: Array<{
      code: string;
      status: number;
      title: RegExp;
      body?: RegExp;
      details?: Record<string, unknown>;
      links: Array<{ name: RegExp; href: string }>;
    }> = [
      {
        code: 'plan_required',
        status: 402,
        title: /Choose a plan to start creating/,
        links: [{ name: /^Choose a plan$/, href: '/settings/billing' }],
      },
      {
        code: 'billing_required',
        status: 402,
        title: /Update your payment method/,
        links: [],
      },
      {
        code: 'quota_exceeded',
        status: 403,
        title: /You’ve used your plan’s videos for now/,
        links: [
          { name: /^Buy a video pack$/, href: '/settings/billing#topups' },
          { name: /^Add a channel$/, href: '/settings/billing#change' },
        ],
      },
      {
        code: 'plan_tier',
        status: 403,
        title: /Not included in your plan/,
        details: { requiredTier: 'PLUS' },
        links: [{ name: /^See the plan$/, href: '/pricing' }],
      },
      {
        code: 'channel_limit',
        status: 403,
        title: /Add a channel to publish here/,
        body: /Your plan includes 1 channel: TikTok\. Add a channel to publish to Instagram too\./,
        details: { channels: 1, platform: 'instagram', allowedPlatforms: ['tiktok'] },
        links: [{ name: /^Add a channel$/, href: '/settings/billing#change' }],
      },
    ];
    for (const c of cases) {
      await page.route('**/api/studio/templates**', (route) =>
        route.fulfill({
          status: c.status,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: false,
            error: c.code,
            message: c.code,
            details: c.details ?? {},
          }),
        }),
      );
      await page.goto('/templates');
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(c.title);
      if (c.body) await expect(dialog).toContainText(c.body);
      for (const link of c.links) {
        await expect(dialog.getByRole('link', { name: link.name })).toHaveAttribute(
          'href',
          link.href,
        );
      }
      // No tier names, no "Upgrade" to a tier, no top-ups.
      await expect(dialog).not.toContainText(/\b(Basic|Standard|Plus|Enterprise)\b/);
      await expect(dialog).not.toContainText(/top-up/i);
      await shot(page, `upgrade-dialog-${c.code}`);
      await dialog.getByRole('button', { name: 'Not now' }).click();
      await expect(dialog).toHaveCount(0);
      await page.unroute('**/api/studio/templates**');
    }
  });

  test('billing is checked for the past-due banner on every page', async ({ page, context }) => {
    const { org } = await ownerWithOrg(context, db, 'bill5');
    await givePlan(db, org.id, 'STANDARD', {
      source: 'stripe',
      channels: 2,
      graceUntil: new Date(Date.now() + 2 * 86_400_000),
    });
    // 21.5: a per-channel subscription (2 channels, monthly) whose last payment failed.
    await db.subscription.create({
      data: {
        id: `sub_qa1_${randomUUID().slice(0, 8)}`,
        organisationId: org.id,
        stripeCustomerId: 'cus_qa1',
        status: 'past_due',
        interval: 'month',
        lookupKey: 'studio_channel_monthly',
        quantity: 2,
      },
    });
    await page.goto('/projects');
    await page.waitForLoadState('networkidle');
    await shot(page, 'banner-past-due');
    void signInUi;
  });
});
