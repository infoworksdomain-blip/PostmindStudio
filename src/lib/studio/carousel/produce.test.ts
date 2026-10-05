import type { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AssetStorage } from '../storage';
import type { StoredCarousel } from './document';
import { blockingIssues, previewSlides, produceCarousel, storeCarousel } from './produce';

let picture: Buffer;
beforeAll(async () => {
  picture = await sharp({
    create: { width: 1200, height: 800, channels: 3, background: { r: 200, g: 120, b: 40 } },
  })
    .jpeg()
    .toBuffer();
});

function fakeStorage() {
  const puts: Array<{ bucket: string; key: string; contentType: string }> = [];
  const storage = {
    put: vi.fn(async (input: { bucket: string; key: string; contentType: string }) => {
      puts.push({ bucket: input.bucket, key: input.key, contentType: input.contentType });
      return { bucket: input.bucket, key: input.key, url: `s3://${input.key}` };
    }),
    size: vi.fn(async () => picture.length),
    readRange: vi.fn(async () => new Uint8Array(picture)),
    signedUrl: vi.fn(async (_b: string, key: string) => `https://signed/${key}`),
    delete: vi.fn(),
  };
  return { storage: storage as unknown as AssetStorage, puts };
}

const db = {
  imageLibraryItem: {
    findFirst: vi.fn(async () => ({ s3Bucket: 'assets', s3Key: 'img.jpg' })),
  },
  videoUpload: { findFirst: vi.fn(async () => null) },
  brandKit: { findFirst: vi.fn(async () => null) },
} as unknown as PrismaClient;

const stored = (over: Partial<StoredCarousel> = {}): StoredCarousel => ({
  version: 1,
  theme: 'light',
  language: 'en-GB',
  profile: { displayName: 'Acme', handle: 'acme', logoUploadId: null },
  posts: [
    {
      id: 'hook',
      text: '5 things about bread 🍞',
      image: { imageId: 'img-1', width: 1200, height: 800, aiGenerated: true },
    },
    { id: 'a', text: 'Short one', image: null },
    { id: 'b', text: 'Short two', image: null },
    { id: 'cta', text: 'Follow us', image: null },
  ],
  postCount: 4,
  aiWritten: true,
  rewrites: 0,
  ...over,
});

const scope = { organisationId: 'org_1', businessId: 'biz_1' };

describe('produceCarousel', () => {
  it('plans and renders every slide, drops emoji and reports AI pictures', async () => {
    const { storage } = fakeStorage();
    const produced = await produceCarousel({ db, storage }, scope, stored());
    expect(produced.slides).toHaveLength(3); // hook, pair, CTA
    expect(produced.prepared.removedCharacters).toBe(1);
    expect(produced.aiGenerated).toBe(true);
    expect(produced.issues).toEqual([]);
  }, 60_000);

  it('warns (without failing) when the hook has no picture', async () => {
    const { storage } = fakeStorage();
    const produced = await produceCarousel(
      { db, storage },
      scope,
      stored({ posts: [{ id: 'hook', text: 'Hook', image: null }] }),
    );
    expect(produced.issues.map((i) => i.code)).toEqual(['hook_without_image']);
    expect(blockingIssues(produced.issues)).toEqual([]);
    expect(produced.aiGenerated).toBe(false);
  }, 60_000);
});

describe('storeCarousel and previewSlides', () => {
  it('uploads a PNG and a JPEG per slide under the project and describes them', async () => {
    const { storage, puts } = fakeStorage();
    const produced = await produceCarousel({ db, storage }, scope, stored());
    const composition = await storeCarousel(
      { storage, bucket: 'renders' },
      { organisationId: 'org_1', projectId: 'prj_1' },
      stored(),
      produced,
    );
    expect(puts).toHaveLength(6);
    expect(
      puts.every((p) => p.bucket === 'renders' && p.key.includes('orgs/org_1/projects/prj_1/')),
    ).toBe(true);
    expect(puts.map((p) => p.contentType)).toEqual([
      'image/png',
      'image/jpeg',
      'image/png',
      'image/jpeg',
      'image/png',
      'image/jpeg',
    ]);
    expect(composition).toMatchObject({ kind: 'carousel', bucket: 'renders', aiGenerated: true });
    expect(composition.slides.map((s) => s.postIds)).toEqual([['hook'], ['a', 'b'], ['cta']]);
    expect(composition.slides[0]?.altText).toBe('5 things about bread');
    const preview = await previewSlides(produced);
    expect(preview.map((s) => s.kind)).toEqual(['single', 'pair', 'single']);
    expect(preview[0]?.image.startsWith('data:image/jpeg;base64,')).toBe(true);
  }, 60_000);
});
