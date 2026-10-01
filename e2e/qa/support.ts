import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import type { PrismaClient } from '@prisma/client';

// QA agent 2 (Create): shared helpers. Accounts are made through the real sign-up endpoint (so
// passwords and sessions are genuine) and the organisation, business, plan and connected
// accounts through Prisma, which keeps each scenario to a few seconds. Nothing here calls a paid
// provider: generation either stops at the billing gate or is queued and never run.

export const PASSWORD = `Qa-${randomUUID()}`;

export type Tier = 'BASIC' | 'STANDARD' | 'PLUS' | null;

export interface Account {
  email: string;
  userId: string;
  organisationId: string;
  businessId: string;
  businessName: string;
  connections: Record<string, string>;
}

export interface AccountOptions {
  label: string;
  /** null = no plan (access none): generating opens the upgrade dialog. */
  tier: Tier;
  /** Connected accounts (platform → display name); each becomes an active platform connection. */
  connect?: Record<string, string>;
}

export async function createAccount(
  db: PrismaClient,
  request: APIRequestContext,
  baseURL: string,
  options: AccountOptions,
): Promise<Account> {
  const run = randomUUID().slice(0, 8);
  const email = `qa-create-${options.label}-${run}@example.test`;
  const res = await request.post('/api/auth/sign-up/email', {
    data: { name: `QA ${options.label}`, email, password: PASSWORD },
    headers: { origin: baseURL },
  });
  expect(res.ok(), `sign-up ${res.status()}`).toBe(true);
  await expect
    .poll(
      async () =>
        (await db.user.updateMany({ where: { email }, data: { emailVerified: true } })).count,
      { timeout: 15_000 },
    )
    .toBe(1);
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  const organisationId = randomUUID();
  await db.organization.create({
    data: {
      id: organisationId,
      name: `QA ${options.label} ${run}`,
      slug: `qa-${run}-${options.label}`,
    },
  });
  await db.member.create({
    data: { id: randomUUID(), organizationId: organisationId, userId: user.id, role: 'owner' },
  });
  const businessName = `QA Bakery ${options.label} ${run}`;
  const business = await db.business.create({
    data: { organisationId, name: businessName, createdByUserId: user.id },
  });
  if (options.tier) {
    await db.orgEntitlement.create({
      data: { organisationId, tier: options.tier, access: 'full', source: 'trial' },
    });
  }
  const connections: Record<string, string> = {};
  for (const [platform, name] of Object.entries(options.connect ?? {})) {
    const row = await db.platformConnection.create({
      data: {
        organisationId,
        businessId: business.id,
        platform,
        platformAccountId: `${platform}-${run}`,
        platformAccountName: name,
        encryptedAccessToken: 'qa-placeholder',
        scopes: ['publish'],
        state: 'active',
        connectedByUserId: user.id,
      },
    });
    connections[platform] = row.id;
  }
  return {
    email,
    userId: user.id,
    organisationId,
    businessId: business.id,
    businessName,
    connections,
  };
}

export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 30_000 }),
    page.getByRole('button', { name: /sign in/i }).click(),
  ]);
}

export async function removeAccount(db: PrismaClient, account: Account): Promise<void> {
  const org = { organisationId: account.organisationId };
  const projects = await db.videoProject.findMany({ where: org, select: { id: true } });
  const ids = projects.map((p) => p.id);
  await db.contentPlan.deleteMany({ where: org });
  await db.slideshowSlide.deleteMany({ where: { projectId: { in: ids } } });
  await db.videoProject.deleteMany({ where: { id: { in: ids } } });
  await db.platformConnection.deleteMany({ where: org });
  await db.orgEntitlement.deleteMany({ where: org });
  await db.business.deleteMany({ where: org });
}

/** Whether BullMQ can run here (it needs Redis 5+; the dev machine has 3, CI has 7). */
export async function queueWorks(): Promise<boolean> {
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/3', {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  try {
    await redis.connect();
    const info = await redis.info('server');
    const major = Number(/redis_version:(\d+)/.exec(info)?.[1] ?? '0');
    return major >= 5;
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

const ERROR_TEXT = [
  /Couldn[’']t load this/,
  /Something went wrong/,
  /You don[’']t have permission/,
  /Application error/,
  /This page hit a problem/,
  /Internal Server Error/,
];

export interface Issue {
  where: string;
  kind: 'banner' | 'pageerror' | 'console' | 'http' | 'blank';
  detail: string;
}

/** The sweep's error detection: banners, page errors, console errors, 5xx and unexpected 4xx. */
export class Watcher {
  readonly issues: Issue[] = [];
  private where = '';

  /** `expected`: "METHOD /path-regex → status" answers that are part of the scenario. */
  constructor(
    page: Page,
    private readonly expected: Array<{ method: string; url: RegExp; status: number }> = [],
  ) {
    page.on('pageerror', (e) =>
      this.issues.push({ where: this.where, kind: 'pageerror', detail: e.message }),
    );
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (/Failed to load resource/.test(text)) return;
      this.issues.push({ where: this.where, kind: 'console', detail: text.slice(0, 300) });
    });
    page.on('response', (res) => {
      const url = res.url();
      if (!url.includes('/api/') || res.status() < 400) return;
      const method = res.request().method();
      const known = this.expected.some(
        (e) => e.method === method && e.status === res.status() && e.url.test(url),
      );
      if (known) return;
      if (
        /\/api\/studio\/(library\/recommended|business-profile|domain-verification)/.test(url) &&
        res.status() === 404
      )
        return;
      this.issues.push({
        where: this.where,
        kind: 'http',
        detail: `${method} ${new URL(url).pathname} → ${res.status()}`,
      });
    });
    this.page = page;
  }
  private readonly page: Page;

  label(name: string): void {
    this.where = name;
  }

  async check(name = this.where): Promise<void> {
    this.where = name;
    const body = (
      await this.page
        .locator('body')
        .innerText()
        .catch(() => '')
    ).trim();
    if (!body) this.issues.push({ where: name, kind: 'blank', detail: 'empty body' });
    for (const re of ERROR_TEXT) {
      if (re.test(body)) this.issues.push({ where: name, kind: 'banner', detail: String(re) });
    }
  }

  async settle(): Promise<void> {
    await this.page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  }

  assertClean(): void {
    expect(this.issues).toEqual([]);
  }
}
