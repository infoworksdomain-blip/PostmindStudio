import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  test as base,
  type Browser,
  type BrowserContext,
  type Page,
  type Response,
} from '@playwright/test';
import { newDb, type Db } from './fixtures';

// QA area "Get started, Settings, Account, Export data" — shared helpers for the
// e2e/qa/onboarding-settings.*.spec.ts files. Needs DATABASE_URL (the app's database) and a
// running app like the sweep (playwright.config.ts).
//
// Every test context sends its own X-Real-IP (the app reads the client address from it when it is
// not behind Caddy, src/lib/auth/config.ts) so the per-IP sign-in / sign-up limits of one test
// never spend another test's budget.

export const hasDb = Boolean(process.env.DATABASE_URL);
export const run = randomUUID().slice(0, 8);
export const PASSWORD = `Qa1-${randomUUID()}`;
const shotsDir = process.env.E2E_QA_SHOTS;

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  // 10.<worker>.<hi>.<lo>: unique per test within a worker, and per worker.
  const worker = (Number(process.env.TEST_WORKER_INDEX ?? 0) % 200) + 1;
  return `10.${worker}.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
}

const ORIGIN = new URL(process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3102').origin;

/** Source address plus the Origin header the app's same-origin check wants on API writes. */
export function headersFor(ip: string): Record<string, string> {
  return { 'x-real-ip': ip, origin: ORIGIN };
}

/** A second signed-in device / user: its own context with its own source address. */
export function newCtx(browser: Browser, ip: string): Promise<BrowserContext> {
  return browser.newContext({ extraHTTPHeaders: headersFor(ip) });
}

export const test = base.extend({
  extraHTTPHeaders: async ({}, provide) => {
    await provide(headersFor(nextIp()));
  },
});
// A cold, single-connection local database answers a page's parallel API calls one at a time, so
// the 15 s default of playwright.config.ts is too tight here; CI passes long before this.
const expect = base.expect.configure({ timeout: 45_000 });
export { expect };

// ---------------------------------------------------------------------------------- database

export function openDb(): Db {
  return newDb();
}

// ------------------------------------------------------------------------- issue detection

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

export interface Issue {
  page: string;
  kind: 'banner' | 'pageerror' | 'console' | 'http' | 'blank';
  detail: string;
}

interface Allowed {
  url: RegExp;
  status: number[];
}

/** 4xx answers that are normal behaviour on every page of this area. */
const ALWAYS_ALLOWED: Allowed[] = [
  { url: /\/api\/auth\/get-session/, status: [401] },
  { url: /\/business-profile$/, status: [404] },
  { url: /\/domain-verification$/, status: [404] },
  { url: /\/api\/studio\/library\/recommended/, status: [404] },
];

/**
 * The sweep's error detection (e2e/sweep.spec.ts): error banners, uncaught page errors, console
 * errors from our code, and API answers that are 5xx or an unexpected 4xx. A test lists the 4xx it
 * provokes on purpose with allow().
 */
export class Watcher {
  readonly issues: Issue[] = [];
  private current = '';
  private readonly allowed: Allowed[] = [...ALWAYS_ALLOWED];
  /** Without an organisation every workspace API answers 403 no_organisation (the shell reacts). */
  noOrganisation = false;
  /** Console errors the browser prints for a failed fetch are reported as http issues instead. */
  private readonly consoleIgnore: RegExp[] = [/Failed to load resource/];

  constructor(page: Page) {
    page.on('pageerror', (err) =>
      this.issues.push({ page: this.current, kind: 'pageerror', detail: err.message }),
    );
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (this.consoleIgnore.some((re) => re.test(text))) return;
      this.issues.push({ page: this.current, kind: 'console', detail: text.slice(0, 300) });
    });
    page.on('response', (res) => void this.onResponse(res));
  }

  /** Expect these 4xx statuses from URLs matching `url` (a deliberate negative test). */
  allow(url: RegExp, ...status: number[]): this {
    this.allowed.push({ url, status });
    return this;
  }

  private async onResponse(res: Response): Promise<void> {
    const url = res.url();
    if (!url.includes('/api/')) return;
    const status = res.status();
    if (status < 400) return;
    if (this.allowed.some((e) => e.url.test(url) && e.status.includes(status))) {
      return;
    }
    if (status === 403) {
      if (this.noOrganisation) return;
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (body.error === 'no_organisation') return;
    }
    this.issues.push({
      page: this.current,
      kind: 'http',
      detail: `${res.request().method()} ${new URL(url).pathname} → ${status}`,
    });
  }

  label(name: string): void {
    this.current = name;
  }

  async settle(page: Page): Promise<void> {
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  }

  /** Records a banner issue when the page shows an error state. */
  async check(page: Page, name = this.current): Promise<void> {
    const body = (
      await page
        .locator('body')
        .innerText()
        .catch(() => '')
    ).trim();
    if (!body) this.issues.push({ page: name, kind: 'blank', detail: 'empty body' });
    for (const re of ERROR_TEXT) {
      if (re.test(body)) this.issues.push({ page: name, kind: 'banner', detail: String(re) });
    }
  }

  async visit(page: Page, path: string, opts: { expectPath?: RegExp } = {}): Promise<void> {
    this.current = path;
    await page.goto(path);
    await this.settle(page);
    if (opts.expectPath) {
      await expect(page).toHaveURL(opts.expectPath);
    }
    await this.check(page, path);
  }

  /** Fails the test with the whole list when anything was recorded. */
  async assertClean(): Promise<void> {
    if (this.issues.length === 0) return;
    const text = JSON.stringify(this.issues, null, 2);
    process.stdout.write(`QA ISSUES\n${text}\n`);
    await test
      .info()
      .attach('qa-issues.json', { body: text, contentType: 'application/json' })
      .catch(() => undefined);
    expect(this.issues).toEqual([]);
  }
}

/** Saves a full-page screenshot into E2E_QA_SHOTS (when set) for the QA proof folder. */
export async function shot(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  mkdirSync(shotsDir, { recursive: true });
  await page
    .screenshot({
      path: join(shotsDir, `${name.replace(/[^a-z0-9-]+/gi, '_')}.png`),
      fullPage: true,
    })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------------- accounts

export interface TestUser {
  id: string;
  email: string;
  name: string;
  password: string;
}

export function uniqueEmail(label: string): string {
  return `qa1-${label}-${randomUUID().slice(0, 8)}@example.test`;
}

function originOf(_context: BrowserContext): string {
  return ORIGIN;
}

/** Sign up through Better Auth's API (as the form does), then mark the address verified. */
export async function createUser(
  context: BrowserContext,
  db: Db,
  label: string,
  options: { name?: string; password?: string } = {},
): Promise<TestUser> {
  const email = uniqueEmail(label);
  const name = options.name ?? `QA ${label}`;
  const password = options.password ?? PASSWORD;
  const res = await context.request.post('/api/auth/sign-up/email', {
    headers: { origin: originOf(context) },
    data: { name, email, password, callbackURL: '/welcome' },
  });
  expect(res.status(), `sign-up ${email}`).toBeLessThan(300);
  const user = await db.user.update({ where: { email }, data: { emailVerified: true } });
  return { id: user.id, email, name, password };
}

/** Sign in through the API; the session cookie lands in the context (shared with its pages). */
export async function signInApi(context: BrowserContext, user: TestUser): Promise<void> {
  const res = await withRetry(() =>
    context.request.post('/api/auth/sign-in/email', {
      headers: { origin: originOf(context) },
      data: { email: user.email, password: user.password },
    }),
  );
  expect(res.status(), `sign-in ${user.email}`).toBeLessThan(300);
}

/** Retries a request the local single-session database or a restarting server reset. */
async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= 3 || !/ECONNRESET|socket hang up/.test(String(err))) throw err;
    }
  }
}

export async function signOutApi(context: BrowserContext): Promise<void> {
  await withRetry(() =>
    context.request.post('/api/auth/sign-out', {
      headers: { origin: originOf(context) },
      data: {},
    }),
  );
}

/** Sign in through the form (the real UI), landing wherever `next` points. */
export async function signInUi(page: Page, user: TestUser, next?: string): Promise<void> {
  await page.goto(next ? `/sign-in?next=${encodeURIComponent(next)}` : '/sign-in');
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 30_000 }),
    page.getByRole('button', { name: 'Sign in', exact: true }).click(),
  ]);
}

export interface OrgInfo {
  id: string;
  name: string;
}

/** Creates an organisation for the signed-in user (it becomes the session's active one). */
export async function createOrg(
  context: BrowserContext,
  db: Db,
  name: string,
  country = 'GB',
): Promise<OrgInfo> {
  const res = await context.request.post('/api/studio/organisations', {
    data: { name, country, defaultLocale: 'en-GB' },
  });
  expect(res.status(), `create organisation ${name}`).toBe(201);
  const org = await db.organization.findFirstOrThrow({
    where: { name },
    orderBy: { createdAt: 'desc' },
  });
  return { id: org.id, name };
}

export async function createBusiness(
  context: BrowserContext,
  name: string,
): Promise<{ id: string; name: string }> {
  const res = await context.request.post('/api/studio/businesses', { data: { name } });
  expect(res.status(), `create business ${name}`).toBeLessThan(300);
  const json = (await res.json()) as { business: { id: string; name: string } };
  return json.business;
}

/** A signed-in owner with an organisation (and optionally a business). */
export async function ownerWithOrg(
  context: BrowserContext,
  db: Db,
  label: string,
  options: { business?: boolean } = {},
): Promise<{ user: TestUser; org: OrgInfo; business?: { id: string; name: string } }> {
  const user = await createUser(context, db, label);
  await signInApi(context, user);
  const org = await createOrg(context, db, `QA ${label} ${run}-${randomUUID().slice(0, 4)}`);
  const business = options.business ? await createBusiness(context, `QA Shop ${label}`) : undefined;
  return { user, org, ...(business && { business }) };
}

/** Adds an already-created user to an organisation with a role (what accepting an invite does). */
export async function addMember(
  db: Db,
  orgId: string,
  userId: string,
  role: 'owner' | 'admin' | 'publisher' | 'creator' | 'viewer',
): Promise<string> {
  const member = await db.member.create({
    data: { id: randomUUID(), organizationId: orgId, userId, role },
  });
  return member.id;
}

/** Points the user's current sessions at an organisation (as the switcher does). */
export async function setActiveOrg(db: Db, userId: string, orgId: string | null): Promise<void> {
  await db.session.updateMany({ where: { userId }, data: { activeOrganizationId: orgId } });
}

/**
 * A plan for the organisation (read by the app within 30 s of its first read: set it first).
 * `tier` is the internal tier (routing, gates); customers never see it. 21.5: pass `channels`
 * (and `interval`) for a per-channel plan — a staff override when the source is admin, otherwise
 * what a Stripe subscription would have stored (status active, or past_due with `graceUntil`).
 */
export async function givePlan(
  db: Db,
  orgId: string,
  tier: 'BASIC' | 'STANDARD' | 'PLUS' = 'STANDARD',
  extra: {
    access?: 'full' | 'read_only';
    source?: string;
    graceUntil?: Date;
    channels?: number;
    interval?: 'week' | 'month' | 'year';
  } = {},
): Promise<void> {
  const access = extra.access ?? 'full';
  const source = extra.source ?? 'admin';
  const plan = extra.channels
    ? { channels: extra.channels, interval: extra.interval ?? 'month' }
    : undefined;
  const overrides = !plan
    ? undefined
    : source === 'admin'
      ? {
          admin: {
            ...plan,
            reason: 'QA seed',
            setByUserId: 'qa',
            setAt: new Date().toISOString(),
          },
        }
      : {
          derived: {
            ...plan,
            tier,
            access,
            source: 'stripe',
            status: extra.graceUntil ? 'past_due' : 'active',
          },
        };
  await db.orgEntitlement.upsert({
    where: { organisationId: orgId },
    create: {
      organisationId: orgId,
      tier,
      access,
      source,
      graceUntil: extra.graceUntil ?? null,
      ...(overrides && { overrides }),
    },
    update: {},
  });
}

// ------------------------------------------------------------------------------------ email

export interface OutboxEmail {
  template: string;
  to: string;
  params: Record<string, unknown>;
}

/** The newest outbox row for an address (Resend is not called locally: the row is the "email"). */
export async function waitForEmail(
  db: Db,
  to: string,
  template: string,
  after: Date = new Date(0),
): Promise<OutboxEmail> {
  let found: OutboxEmail | undefined;
  await expect
    .poll(
      async () => {
        const row = await db.emailOutbox.findFirst({
          where: { toAddress: to.toLowerCase(), template, createdAt: { gt: after } },
          orderBy: { createdAt: 'desc' },
        });
        if (row) {
          found = {
            template: row.template,
            to: row.toAddress,
            params: row.params as Record<string, unknown>,
          };
        }
        return Boolean(row);
      },
      { timeout: 30_000, message: `outbox email ${template} to ${to}` },
    )
    .toBe(true);
  return found as OutboxEmail;
}

export function linkOf(email: OutboxEmail): string {
  const url = email.params.url;
  if (typeof url !== 'string') throw new Error(`email ${email.template} has no url`);
  return url;
}

export async function countEmails(db: Db, to: string, template: string): Promise<number> {
  return db.emailOutbox.count({ where: { toAddress: to.toLowerCase(), template } });
}

// -------------------------------------------------------------------------------------- 2FA

/** The current 6-digit code for an otpauth:// URI (RFC 6238, SHA-1, 30 s). */
export function totp(uri: string, offsetSteps = 0): string {
  const secret = new URL(uri).searchParams.get('secret') ?? '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  }
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offsetSteps));
  const hmac = createHmac('sha1', bytes).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

/** Turns two-step verification on through the account page; returns the TOTP URI and codes. */
export async function enrolTwoFactor(
  page: Page,
  password: string,
): Promise<{ totpURI: string; backupCodes: string[] }> {
  await page.goto('/account/security');
  const section = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Two-step verification' }) });
  await section.getByLabel('Password', { exact: true }).fill(password);
  const [enrol] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/two-factor/enable')),
    section.getByRole('button', { name: 'Set up' }).click(),
  ]);
  const body = (await enrol.json()) as { totpURI: string; backupCodes: string[] };
  await page.getByLabel('Code from the app').fill(totp(body.totpURI));
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByText('Two-step verification is on.').first()).toBeVisible();
  return body;
}

/** Waits for the "… added." style toast to be gone so a click is not swallowed by it. */
export async function toastsGone(page: Page): Promise<void> {
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 15_000 });
}

export async function toast(page: Page, text: string | RegExp): Promise<void> {
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: text }).first()).toBeVisible();
}
