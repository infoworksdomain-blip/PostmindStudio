import { createHmac } from 'node:crypto';
import { expect, type Browser, type Page } from '@playwright/test';
import { createUser, password, run, signedInPage, type Db } from './fixtures';
import { Watcher } from './watcher';

// 20.31 (QA pass 2): helpers shared by the accessibility, per-screen and mobile / dark / keyboard
// specs. Accounts come from fixtures.ts (real sign-up API, Prisma-seeded organisation).

export const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3102';

/** The six legal documents (src/lib/legal/documents.ts). */
export const LEGAL_DOCS = [
  'terms',
  'privacy',
  'cookies',
  'acceptable-use',
  'dpa',
  'subprocessors',
] as const;

/** Pages without a session. */
export const PUBLIC_PAGES = [
  '/',
  '/pricing',
  '/sign-in',
  '/sign-up',
  '/forgot-password',
  ...LEGAL_DOCS.map((d) => `/legal/${d}`),
];

/** Every signed-in page of the app shell (the sweep's list plus Plan my month and the editors). */
export const WORKSPACE_PAGES = [
  '/new',
  '/projects',
  '/library',
  '/templates',
  '/publications',
  '/calendar',
  '/analytics',
  '/business',
  '/connections',
  '/approvals',
  '/plans',
  '/plans/new',
  '/settings/organisation',
  '/settings/members',
  '/settings/billing',
  '/settings/audit',
  '/account/profile',
  '/account/security',
  '/account/export',
];

/**
 * Turn on two-step verification from /account/security. In CI every request shares one rate-limit
 * bucket (no client IP), so a burst of staff sign-ups can get the enrol call refused; retry after the
 * window instead of failing with no setup link.
 */
export async function enableTwoFactor(page: Page, password: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    await page.goto('/account/security');
    const twoFactor = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Two-step verification' }) });
    await twoFactor.getByLabel('Password', { exact: true }).fill(password);
    const [enrol] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/two-factor/enable')),
      page.getByRole('button', { name: 'Set up' }).click(),
    ]);
    const body = (await enrol.json().catch(() => ({}))) as { totpURI?: string };
    if (enrol.ok() && body.totpURI) {
      await page.getByLabel('Code from the app').fill(totp(body.totpURI));
      await page.getByRole('button', { name: 'Turn on' }).click();
      return;
    }
    if (attempt >= 5) {
      throw new Error(`2FA enrol refused (HTTP ${enrol.status()}) after ${attempt} attempts`);
    }
    await page.waitForTimeout(15_000);
  }
}

export function totp(uri: string): string {
  const secret = new URL(uri).searchParams.get('secret') ?? '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  }
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const hmac = createHmac('sha1', bytes).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

/**
 * A signed-in page for platform staff: a superadmin with no organisation and two-step
 * verification switched on (the Admin Centre refuses staff without it), like the sweep does.
 */
export async function staffPage(
  browser: Browser,
  playwrightRequest: Parameters<typeof createUser>[0],
  db: Db,
  viewport?: { width: number; height: number },
  /** One staff user per spec file: files run in parallel and each cleans up its own user. */
  label = 'staff',
): Promise<{ page: Page; email: string; userId: string }> {
  const email = `qa-p2-staff-${label}-${run}@example.test`;
  const userId = await createUser(playwrightRequest, db, baseURL, email, 'QA Staff');
  await db.user.update({ where: { email }, data: { role: 'superadmin' } });
  const page = await signedInPage(browser, baseURL, email, { viewport });
  await enableTwoFactor(page, password);
  await expect(page.getByText('Two-step verification is on.').first()).toBeVisible({
    timeout: 60_000,
  });
  return { page, email, userId };
}

/** Make the next navigations of this page's context use the dark theme (next-themes key). */
export async function enableDarkTheme(page: Page): Promise<void> {
  await page.context().addInitScript(() => window.localStorage.setItem('theme', 'dark'));
}

export const noHorizontalScroll = (page: Page): Promise<boolean> =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
  );

/** An error watcher that knows the 404s a business with no website scan answers on purpose. */
export function watch(page: Page): Watcher {
  const w = new Watcher(page);
  w.expect4xx(
    /\/api\/studio\/(?:.*\/)?(?:business-profile|library\/recommended|domain-verification)([?].*)?$/,
    404,
  );
  return w;
}
