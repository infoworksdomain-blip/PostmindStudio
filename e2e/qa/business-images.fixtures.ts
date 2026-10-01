import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import type { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { PASSWORD, randomIp, type Account } from './support';

// QA 6 (Business & Images, Connections): Prisma fixtures and small helpers. Nothing here calls a
// paid provider or a social platform: scans are driven by database rows (the worker's job), the
// embedding API is e2e/qa/embedding-stub.cjs and object storage is e2e/qa/s3-stub.mjs.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { embed } = require('./embedding-stub.cjs') as { embed: (text: string) => number[] };

export const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A PNG big enough for the library (long edge >= 500 px) and different for each seed. */
export async function pngBytes(seed: number, width = 800, height = 600): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 3) {
    raw[i] = (i * 7 + seed * 31) % 256;
    raw[i + 1] = (i * 13 + seed * 17) % 256;
    raw[i + 2] = (seed * 53) % 256;
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

/** Signed preview URLs and hotlinked photos: nothing leaves the machine, every image is a pixel. */
export async function stubImages(page: Page): Promise<void> {
  await page.route(/127\.0\.0\.1:3199|\.amazonaws\.com|images\.qa-stock\.test/, (route) => {
    const request = route.request();
    if (request.method() === 'PUT') return route.fulfill({ status: 200, body: '' });
    return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
  });
}

/** A signed-in browser state for an account (one sign-in per account, reused by every page). */
export async function sessionFor(browser: Browser, email: string, state: string): Promise<void> {
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'x-real-ip': randomIp() });
  await page.goto('/sign-in');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 180_000 }),
    page.getByRole('button', { name: /sign in/i }).click(),
  ]);
  await page.context().storageState({ path: state });
  await page.close();
}

/** A user who belongs to an existing organisation with a given role (viewer, creator, ...). */
export async function addMember(
  db: PrismaClient,
  request: APIRequestContext,
  baseURL: string,
  organisationId: string,
  role: string,
): Promise<{ email: string; userId: string }> {
  const email = `qa-members-${role}-${randomUUID().slice(0, 8)}@example.test`;
  const res = await request.post('/api/auth/sign-up/email', {
    data: { name: `QA ${role}`, email, password: PASSWORD },
    headers: { origin: baseURL, 'x-real-ip': randomIp() },
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
  await db.member.create({
    data: { id: randomUUID(), organizationId: organisationId, userId: user.id, role },
  });
  return { email, userId: user.id };
}

export async function seedProfile(
  db: PrismaClient,
  account: Pick<Account, 'organisationId' | 'businessId'>,
  overrides: { needsReview?: boolean; confidence?: number } = {},
): Promise<void> {
  await db.businessProfile.create({
    data: {
      organisationId: account.organisationId,
      businessId: account.businessId,
      industry: 'Food and drink',
      subNiche: 'artisan sourdough',
      products: ['sourdough loaves', 'bread subscription'],
      services: ['weekly delivery'],
      audienceKeywords: ['Leeds professionals'],
      toneIndicators: ['warm', 'crafted'],
      regions: ['UK'],
      imageThemes: ['bread', 'bakery'],
      imageSearchQueries: ['sourdough bread', 'artisan bakery'],
      restrictedTopics: [],
      brandVoiceSummary: 'Warm and proud of the craft.',
      classifierModel: 'qa-stub:model',
      classifierConfidence: overrides.confidence ?? 0.9,
      needsReview: overrides.needsReview ?? false,
    },
  });
}

export async function seedScan(
  db: PrismaClient,
  account: Pick<Account, 'organisationId' | 'businessId'>,
  data: {
    state: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
    url?: string;
    pagesCrawled?: number;
    imagesIngested?: number;
    errorReason?: string | null;
    robotsBlocked?: boolean;
    startedAt?: Date;
  },
): Promise<string> {
  const scan = await db.websiteScan.create({
    data: {
      organisationId: account.organisationId,
      businessId: account.businessId,
      url: data.url ?? 'https://qa-bakery.example/',
      state: data.state,
      pagesCrawled: data.pagesCrawled ?? 0,
      imagesIngested: data.imagesIngested ?? 0,
      errorReason: data.errorReason ?? null,
      robotsBlocked: data.robotsBlocked ?? false,
      startedAt: data.startedAt ?? new Date(),
      completedAt: data.state === 'SUCCEEDED' || data.state === 'FAILED' ? new Date() : null,
      ownershipConfirmedAt: new Date(),
      planTier: 'PLUS',
    },
  });
  return scan.id;
}

type Source = 'SCRAPED' | 'STOCK' | 'GENERATED' | 'UPLOAD';

export interface SeedImage {
  source: Source;
  tags?: string[];
  altText?: string | null;
  /** Hotlinked (no stored copy): previewUrl is publicUrl. */
  hotlinked?: boolean;
  /** Give it a search embedding (embedding-stub's bag of words over alt text and tags). */
  embedded?: boolean;
  createdAt?: Date;
}

/** Library rows without bytes: stored rows presign a preview URL, hotlinked rows use publicUrl. */
export async function seedImages(
  db: PrismaClient,
  account: Pick<Account, 'organisationId' | 'businessId'>,
  images: SeedImage[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const [index, image] of images.entries()) {
    const id = randomUUID();
    const key = `qa/${id}.png`;
    await db.imageLibraryItem.create({
      data: {
        id,
        organisationId: account.organisationId,
        businessId: account.businessId,
        source: image.source,
        sourceProvider: image.hotlinked ? 'unsplash' : 'qa',
        s3Bucket: image.hotlinked ? '' : 'ci-library',
        s3Key: image.hotlinked ? '' : key,
        publicUrl: image.hotlinked ? `https://images.qa-stock.test/${id}.png` : null,
        widthPx: 1200,
        heightPx: 800,
        fileSizeBytes: 90_000,
        tags: image.tags ?? [],
        altText: image.altText ?? null,
        fingerprint: `qa-${id}`,
        createdAt: image.createdAt ?? new Date(Date.now() - index * 1_000),
      },
    });
    if (image.embedded) {
      const text = [image.altText, (image.tags ?? []).join(' ')].filter(Boolean).join(' ');
      const vector = `[${embed(text).join(',')}]`;
      await db.$executeRawUnsafe(
        `UPDATE studio.image_library SET embedding = $1::vector WHERE id = $2`,
        vector,
        id,
      );
    }
    ids.push(id);
  }
  return ids;
}

export async function removeBusinessData(db: PrismaClient, organisationId: string): Promise<void> {
  const org = { organisationId };
  await db.imageLibraryItem.deleteMany({ where: org });
  await db.websiteScan.deleteMany({ where: org });
  await db.businessProfile.deleteMany({ where: org });
  await db.styleMemory.deleteMany({ where: org });
  await db.businessHashtagSettings.deleteMany({ where: org });
  await db.brandKit.deleteMany({ where: org });
}
