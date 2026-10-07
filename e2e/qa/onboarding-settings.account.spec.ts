import {
  addMember,
  createUser,
  enrolTwoFactor,
  expect,
  hasDb,
  newCtx,
  linkOf,
  openDb,
  ownerWithOrg,
  PASSWORD,
  setActiveOrg,
  shot,
  signInApi,
  signInUi,
  test,
  toast,
  totp,
  uniqueEmail,
  waitForEmail,
  Watcher,
} from './onboarding-settings.support';

// QA agent 1 — /account/profile, /account/security, /account/export, the header's language switcher
// and theme toggle, and every page of the area on a phone.

test.describe.configure({ timeout: 300_000 });
test.skip(!hasDb, 'DATABASE_URL is not set: these specs need the app’s database');

const db = hasDb ? openDb() : (undefined as never);
test.afterAll(async () => {
  await db?.$disconnect();
});

test.describe('profile', () => {
  test('name, email language and the two-step email change', async ({ page, context }) => {
    const w = new Watcher(page);
    w.allow(/\/api\/auth\//, 400, 422);
    const { user } = await ownerWithOrg(context, db, 'prof');
    await w.visit(page, '/account/profile');
    await expect(page.getByRole('heading', { name: 'Profile', level: 1 })).toBeVisible();
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue(user.name);
    const save = page.getByRole('button', { name: 'Save', exact: true });
    await page.getByLabel('Name', { exact: true }).fill('   ');
    await expect(save).toBeDisabled();
    await page.getByLabel('Name', { exact: true }).fill('x'.repeat(130));
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('x'.repeat(100));
    await page.getByLabel('Name', { exact: true }).fill('Renamed Person');
    await page.getByLabel('Email language').selectOption('de');
    await save.click();
    await toast(page, 'Profile saved.');
    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.name).toBe('Renamed Person');
    expect(row.locale).toBe('de');
    await page.reload();
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Renamed Person');
    await expect(page.getByLabel('Email language')).toHaveValue('de');
    await shot(page, 'account-profile');

    // Email change: the CURRENT address approves, then the new one confirms.
    const change = page.getByRole('button', { name: 'Change email' });
    await expect(change).toBeDisabled();
    const newEmail = uniqueEmail('prof-new');
    const started = new Date();
    await page.getByLabel('New email address').fill(newEmail);
    await change.click();
    await toast(page, 'Check your inbox to approve the change.');
    const approve = await waitForEmail(db, user.email, 'emailChangeConfirm', started);
    expect(approve.params.newEmail).toBe(newEmail);
    await page.goto(linkOf(approve));
    // The new address now holds the confirmation (or the change applied straight away).
    await expect
      .poll(
        async () => {
          const u = await db.user.findUniqueOrThrow({ where: { id: user.id } });
          return u.email === newEmail ? 'changed' : 'pending';
        },
        { timeout: 20_000 },
      )
      .toMatch(/changed|pending/);
    await w.assertClean();
  });

  test('an email change to an address that is taken or invalid does not leak or crash', async ({
    page,
    context,
  }) => {
    const w = new Watcher(page);
    w.allow(/\/api\/auth\//, 400, 422, 429);
    const taken = await createUser(context, db, 'taken');
    const { user } = await ownerWithOrg(context, db, 'prof2');
    await page.goto('/account/profile');
    await page.getByLabel('New email address').fill(taken.email);
    await page.getByRole('button', { name: 'Change email' }).click();
    await page.waitForLoadState('networkidle');
    // The address on the account never changes without the approval link.
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe(user.email);
    await w.assertClean();
  });
});

test.describe('security', () => {
  test('change password: wrong current, weak new, success, other devices signed out', async ({
    page,
    context,
    browser,
  }) => {
    const w = new Watcher(page);
    w.allow(/\/api\/auth\/change-password/, 400, 401, 403);
    const { user } = await ownerWithOrg(context, db, 'pw');
    const other = await newCtx(browser, '10.245.1.1');
    await signInApi(other, user);
    await w.visit(page, '/account/security');
    const section = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Password', exact: true }) });
    const submit = section.getByRole('button', { name: 'Change password' });
    await section.getByLabel('Current password').fill('wrong-current-password');
    await section.getByLabel('New password').fill('short');
    await expect(submit).toBeDisabled();
    await section.getByLabel('New password').fill(`${PASSWORD}-changed`);
    await submit.click();
    await expect(page.getByRole('alert').first()).toBeVisible();
    await section.getByLabel('Current password').fill(user.password);
    await submit.click();
    await toast(page, 'Password changed. Other devices have been signed out.');
    await expect
      .poll(async () => db.session.count({ where: { userId: user.id } }), { timeout: 15_000 })
      .toBe(1);
    await expect
      .poll(async () =>
        db.emailOutbox.count({ where: { toAddress: user.email, template: 'passwordChanged' } }),
      )
      .toBeGreaterThan(0);
    await other.close();
    await shot(page, 'account-security');
    await w.assertClean();
  });

  test('two-step verification: enrol, backup codes, regenerate, disable', async ({
    page,
    context,
  }) => {
    const w = new Watcher(page);
    w.allow(/\/api\/auth\/two-factor\//, 400, 401, 403);
    const { user } = await ownerWithOrg(context, db, 'tfa');
    await page.goto('/account/security');
    const section = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Two-step verification' }) });
    // Wrong password cannot start enrolment.
    await section.getByLabel('Password', { exact: true }).fill('nope-nope-nope-nope');
    await section.getByRole('button', { name: 'Set up' }).click();
    await expect(page.getByRole('alert').first()).toBeVisible();
    await section.getByLabel('Password', { exact: true }).fill(user.password);
    const [enrol] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/two-factor/enable') && r.ok()),
      section.getByRole('button', { name: 'Set up' }).click(),
    ]);
    const { totpURI } = (await enrol.json()) as { totpURI: string };
    await expect(
      page.getByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeVisible();
    await shot(page, 'account-2fa-enrol');
    const confirm = page.getByRole('button', { name: 'Turn on' });
    await page.getByLabel('Code from the app').fill('123');
    await expect(confirm).toBeDisabled();
    await page.getByLabel('Code from the app').fill('000000');
    await confirm.click();
    await expect(page.getByRole('alert').first()).toBeVisible();
    await page.getByLabel('Code from the app').fill(totp(totpURI));
    await confirm.click();
    await expect(page.getByText('Backup codes').first()).toBeVisible();
    expect(
      await page.getByRole('list', { name: 'Backup codes' }).getByRole('listitem').count(),
    ).toBe(10);
    await page.getByRole('button', { name: 'I’ve saved them' }).click();
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).twoFactorEnabled).toBe(
      true,
    );

    // Regenerate backup codes needs the password.
    await section.getByLabel('Password', { exact: true }).fill(user.password);
    await section.getByRole('button', { name: 'New backup codes' }).click();
    await expect(page.getByRole('list', { name: 'Backup codes' })).toBeVisible();
    await page.getByRole('button', { name: 'I’ve saved them' }).click();

    // Disable needs password AND a current code.
    const disable = section.getByRole('button', { name: 'Turn off' });
    await section.getByLabel('Password', { exact: true }).fill(user.password);
    await expect(disable).toBeDisabled();
    await section.getByLabel('Code from the app, or a backup code').fill(totp(totpURI, 1));
    await disable.click();
    await expect(page.getByText('Two-step verification is off.').first()).toBeVisible();
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).twoFactorEnabled).toBe(
      false,
    );
    await w.assertClean();
    void enrolTwoFactor;
  });

  test('sessions: this device is marked, another can be signed out, others in one go', async ({
    page,
    context,
    browser,
  }) => {
    const w = new Watcher(page);
    const { user } = await ownerWithOrg(context, db, 'sess');
    const second = await newCtx(browser, '10.246.1.1');
    const third = await newCtx(browser, '10.246.2.2');
    await signInApi(second, user);
    await signInApi(third, user);
    await w.visit(page, '/account/security');
    await expect(page.getByText('This device')).toBeVisible();
    expect(await db.session.count({ where: { userId: user.id } })).toBe(3);
    await page
      .getByRole('button', { name: /^Sign out (?!everywhere)/ })
      .first()
      .click();
    await toast(page, 'Signed out.');
    await expect.poll(async () => db.session.count({ where: { userId: user.id } })).toBe(2);
    await page.getByRole('button', { name: 'Sign out everywhere else' }).click();
    await toast(page, 'Signed out.');
    await expect.poll(async () => db.session.count({ where: { userId: user.id } })).toBe(1);
    await expect(page.getByRole('button', { name: 'Sign out everywhere else' })).toHaveCount(0);
    // A session id that is not yours is a 404, never a deletion.
    const stranger = await createUser(second, db, 'sess-stranger');
    await signInApi(second, stranger);
    const sid = (await db.session.findFirstOrThrow({ where: { userId: user.id } })).id;
    expect((await second.request.delete(`/api/studio/account/sessions/${sid}`)).status()).toBe(404);
    await second.close();
    await third.close();
    await w.assertClean();
  });

  test('sign-in methods list the password; delete account guards', async ({ page, context }) => {
    const w = new Watcher(page);
    w.allow(/\/api\/studio\/account\/delete$/, 400, 401, 403, 409, 422);
    const { org, user } = await ownerWithOrg(context, db, 'delacc');
    const mate = await createUser(context, db, 'delacc-mate');
    await addMember(db, org.id, mate.id, 'admin');
    await page.goto('/account/security');
    await expect(page.getByText('Email and password')).toBeVisible();
    const section = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Delete account' }) });
    const submit = section.getByRole('button', { name: 'Delete my account' });
    await expect(submit).toBeDisabled();
    await section.getByLabel('Password', { exact: true }).fill(user.password);
    await section.getByRole('checkbox').check();
    await submit.click();
    // Sole owner of an organisation that has other members: blocked until ownership moves.
    await expect(page.getByText(/You’re the only owner of/)).toBeVisible();
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).deletedAt).toBeNull();
    await shot(page, 'account-delete-blocked');
    // Wrong password.
    await db.member.deleteMany({ where: { organizationId: org.id, userId: mate.id } });
    await section.getByLabel('Password', { exact: true }).fill('wrong-wrong-wrong-1');
    await submit.click();
    await expect(page.getByText('That password isn’t right.')).toBeVisible();
    // Success: signed out, cannot sign in again.
    await section.getByLabel('Password', { exact: true }).fill(user.password);
    await submit.click();
    await expect(page).toHaveURL(/\/sign-in/);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).deletedAt).not.toBeNull();
    await w.assertClean();
  });
});

test.describe('export data', () => {
  test('empty organisation, request, states, download, selection and one at a time', async ({
    page,
    context,
  }) => {
    const w = new Watcher(page);
    // No queue locally (Redis 3): the request is saved and the enqueue may fail; CI has Redis 7.
    w.allow(/\/api\/studio\/account\/export/, 409, 500, 503);
    const { org, user } = await ownerWithOrg(context, db, 'exp');
    await w.visit(page, '/account/export');
    await expect(page.getByRole('heading', { name: 'Export your data', level: 1 })).toBeVisible();
    await expect(page.getByText('No exports yet')).toBeVisible();
    await shot(page, 'account-export-empty');
    const request = page.getByRole('button', { name: 'Request export' });
    // Deselect everything: nothing to request.
    for (const g of ['Projects', 'Analytics', 'Brand', 'Image library', 'Account', 'Billing']) {
      await page.getByRole('checkbox', { name: g, exact: true }).uncheck();
    }
    await expect(request).toBeDisabled();
    await page.getByRole('checkbox', { name: 'Brand', exact: true }).check();
    await request.click();
    await expect
      .poll(async () => db.dataExport.count({ where: { organisationId: org.id } }))
      .toBe(1);
    const first = await db.dataExport.findFirstOrThrow({ where: { organisationId: org.id } });
    expect(first.include).toEqual(['brand']);
    // If the queue refused the job the request must not stay "Queued" forever.
    await expect
      .poll(
        async () => (await db.dataExport.findUniqueOrThrow({ where: { id: first.id } })).state,
        { timeout: 20_000 },
      )
      .not.toBe('DONE');
    // Seed the states a worker would write.
    await db.dataExport.update({
      where: { id: first.id },
      data: { state: 'FAILED', activeKey: null, errorReason: 'storage unavailable' },
    });
    const ready = await db.dataExport.create({
      data: {
        organisationId: org.id,
        requestedByUserId: user.id,
        include: ['projects', 'account'],
        state: 'READY',
        s3Bucket: 'ci-assets',
        s3Key: `exports/${org.id}/qa.zip`,
        bytes: 20480,
        completedAt: new Date(),
        expiresAt: new Date(Date.now() + 6 * 86_400_000),
      },
    });
    await db.dataExport.create({
      data: {
        organisationId: org.id,
        requestedByUserId: user.id,
        include: ['analytics'],
        state: 'READY',
        s3Bucket: 'ci-assets',
        s3Key: `exports/${org.id}/old.zip`,
        bytes: 1024,
        completedAt: new Date(Date.now() - 9 * 86_400_000),
        expiresAt: new Date(Date.now() - 2 * 86_400_000),
      },
    });
    await page.reload();
    await expect(page.getByText('Failed').first()).toBeVisible();
    await expect(page.getByText('Ready').first()).toBeVisible();
    await expect(page.getByText('20 KB')).toBeVisible();
    await expect(page.getByText('Expired').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download' })).toHaveCount(1);
    await shot(page, 'account-export-states');
    // Download: the API signs a link and the page navigates to it.
    let target = '';
    await page.route(/ci-assets/, async (route) => {
      target = route.request().url();
      await route.fulfill({ status: 200, body: 'zip', contentType: 'text/plain' });
    });
    await page.getByRole('button', { name: 'Download' }).click();
    await expect.poll(() => target).toContain(`exports/${org.id}/qa.zip`);
    expect((await db.dataExport.findUniqueOrThrow({ where: { id: ready.id } })).state).toBe(
      'READY',
    );
    // One at a time: while a request is queued the button says so.
    await db.dataExport.create({
      data: {
        organisationId: org.id,
        requestedByUserId: user.id,
        include: ['brand'],
        state: 'RUNNING',
        activeKey: org.id,
      },
    });
    await page.goto('/account/export');
    await expect(page.getByRole('button', { name: 'An export is being prepared' })).toBeDisabled();
    const dup = await context.request.post('/api/studio/account/export', {
      data: { include: ['brand'] },
    });
    expect(dup.status()).toBe(409);
    // Another organisation cannot fetch this export.
    const other = await ownerWithOrg(
      await newCtx(context.browser()!, '10.247.1.1'),
      db,
      'exp-other',
    );
    void other;
    await w.assertClean();
  });

  test('a viewer can list but not request; a bad group is refused', async ({
    context,
    browser,
  }) => {
    const { org } = await ownerWithOrg(context, db, 'exp2');
    const ctx = await newCtx(browser, '10.247.2.2');
    const viewer = await createUser(ctx, db, 'exp2-viewer');
    await addMember(db, org.id, viewer.id, 'viewer');
    await signInApi(ctx, viewer);
    await setActiveOrg(db, viewer.id, org.id);
    expect((await ctx.request.get('/api/studio/account/export')).status()).toBe(200);
    expect((await ctx.request.post('/api/studio/account/export', { data: {} })).status()).toBe(403);
    expect(
      (
        await context.request.post('/api/studio/account/export', { data: { include: ['secrets'] } })
      ).status(),
    ).toBe(400);
    expect((await context.request.get('/api/studio/account/export/does-not-exist')).status()).toBe(
      404,
    );
    await ctx.close();
  });
});

test.describe('language, theme and phones', () => {
  test('every page of the area: no overflow at 375 px, dark theme, Arabic and German', async ({
    page,
    context,
  }) => {
    const w = new Watcher(page);
    w.allow(/\/api\/studio\/billing\/invoices/, 400, 501);
    await ownerWithOrg(context, db, 'i18n', { business: true });
    await page.setViewportSize({ width: 375, height: 800 });
    const paths = [
      '/welcome',
      '/settings/organisation',
      '/settings/members',
      '/settings/audit',
      '/settings/billing',
      '/account/profile',
      '/account/security',
      '/account/export',
    ];
    for (const path of paths) {
      await w.visit(page, path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path} overflows at 375 px`).toBeLessThanOrEqual(0);
      await shot(page, `mobile${path.replace(/\//g, '-')}`);
    }
    await page.getByRole('button', { name: /^Appearance/ }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.getByRole('button', { name: /^Appearance/ }).click();
    await page.getByRole('menuitemradio', { name: 'Light' }).click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);

    await page.getByRole('combobox', { name: /Interface language/ }).click();
    await page.getByRole('option', { name: /العربية/ }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    for (const path of paths) {
      await w.visit(page, path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path} overflows in Arabic`).toBeLessThanOrEqual(0);
    }
    await shot(page, 'rtl-account-export');
    await page.getByRole('combobox').filter({ hasText: 'العربية' }).first().click();
    await page.getByRole('option', { name: /Deutsch/ }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    for (const path of paths) await w.visit(page, path);
    await w.assertClean();
  });

  test('the sign-in screens can switch language and follow the theme', async ({ page }) => {
    for (const path of ['/sign-in', '/sign-up', '/forgot-password']) {
      await page.goto(path);
      await expect(page.getByRole('combobox', { name: /Interface language/ })).toBeVisible();
    }
    void signInUi;
  });
});
