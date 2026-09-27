import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { imageSize } from 'image-size';
import { describe, expect, it, vi } from 'vitest';
import { fakePng } from '../../../../test/helpers/png';
import { memoryStorage } from '../../../../test/helpers/memory-storage';
import {
  MAX_IMAGE_BYTES,
  MIN_LONG_EDGE_PX,
  embeddingText,
  fingerprintOf,
  ingestImage,
  looksLikeIconOrTracker,
  normaliseTags,
  recordHotlinkedImage,
  vectorLiteral,
  type IngestDeps,
} from './ingest';

function fakeDb() {
  const imageLibraryItem = {
    findUnique: vi.fn(async () => null),
    findFirst: vi.fn(async () => null),
    create: vi.fn(async () => ({ id: 'row-1' })),
    findUniqueOrThrow: vi.fn(async () => ({ id: 'winner-1' })),
    upsert: vi.fn(async () => ({ id: 'row-1', createdAt: new Date(0) })),
  };
  return { imageLibraryItem, db: { imageLibraryItem } as unknown as PrismaClient };
}

function fakeIngestDeps(overrides: Partial<IngestDeps> = {}) {
  const { db } = fakeDb();
  const { storage, objects } = memoryStorage();
  const fetchImpl = vi.fn(async () => new Response(fakePng(600, 600), { status: 200 }));
  return {
    deps: {
      db,
      storage,
      bucket: 'studio-library-assets',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...overrides,
    } as IngestDeps,
    objects,
    fetchImpl,
  };
}

describe('looksLikeIconOrTracker', () => {
  it('flags known social/tracker hosts, including subdomains', () => {
    expect(
      looksLikeIconOrTracker({
        url: 'https://www.facebook.com/plugins/like.png',
        declaredWidth: null,
        declaredHeight: null,
      }),
    ).toBe(true);
    expect(
      looksLikeIconOrTracker({
        url: 'https://pixel.doubleclick.net/x.gif',
        declaredWidth: null,
        declaredHeight: null,
      }),
    ).toBe(true);
  });

  it('flags tracker/icon path patterns', () => {
    for (const url of [
      'https://example.com/favicon.ico',
      'https://example.com/img/sprite.png',
      'https://example.com/blank.gif',
      'https://example.com/icons/share.png',
      'https://example.com/social-icon-x.png',
      'https://example.com/share-button.png',
    ]) {
      expect(looksLikeIconOrTracker({ url, declaredWidth: null, declaredHeight: null })).toBe(true);
    }
  });

  it('flags SVGs unconditionally', () => {
    expect(
      looksLikeIconOrTracker({
        url: 'https://example.com/logo.svg',
        declaredWidth: 2000,
        declaredHeight: 2000,
      }),
    ).toBe(true);
  });

  it('flags declared dimensions below MIN_LONG_EDGE_PX', () => {
    expect(
      looksLikeIconOrTracker({
        url: 'https://example.com/photo.jpg',
        declaredWidth: 499,
        declaredHeight: 100,
      }),
    ).toBe(true);
    expect(
      looksLikeIconOrTracker({
        url: 'https://example.com/photo.jpg',
        declaredWidth: 100,
        declaredHeight: 499,
      }),
    ).toBe(true);
  });

  it('passes through an ordinary, sufficiently large photo URL', () => {
    expect(
      looksLikeIconOrTracker({
        url: 'https://example.com/blog/bakery-photo.jpg',
        declaredWidth: 1200,
        declaredHeight: 800,
      }),
    ).toBe(false);
  });

  it('does not flag when dimensions are unknown (declared 0/null)', () => {
    expect(
      looksLikeIconOrTracker({
        url: 'https://example.com/blog/bakery-photo.jpg',
        declaredWidth: null,
        declaredHeight: null,
      }),
    ).toBe(false);
  });
});

describe('fingerprintOf', () => {
  it('returns the sha256 hex digest of the bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(fingerprintOf(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('is deterministic and sensitive to content', () => {
    const a = fingerprintOf(new Uint8Array([1, 2, 3]));
    const b = fingerprintOf(new Uint8Array([1, 2, 3]));
    const c = fingerprintOf(new Uint8Array([1, 2, 4]));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(64);
  });
});

describe('normaliseTags', () => {
  it('trims, lowercases and dedupes', () => {
    expect(normaliseTags(['  Bread  ', 'bread', 'BREAD'])).toEqual(['bread']);
  });

  it('drops empty/whitespace-only tags', () => {
    expect(normaliseTags(['  ', '', 'valid'])).toEqual(['valid']);
  });

  it('truncates each tag to 60 characters', () => {
    const long = 'x'.repeat(100);
    expect(normaliseTags([long])[0]).toHaveLength(60);
  });

  it('caps the number of tags at 30', () => {
    const many = Array.from({ length: 50 }, (_, i) => `tag-${i}`);
    expect(normaliseTags(many)).toHaveLength(30);
  });
});

describe('embeddingText', () => {
  it('joins altText, generatedFromPrompt and comma-joined tags with ". "', () => {
    expect(
      embeddingText({
        altText: 'fresh bread',
        tags: ['bakery', 'bread'],
        generatedFromPrompt: 'a warm loaf',
      }),
    ).toBe('fresh bread. a warm loaf. bakery, bread');
  });

  it('drops falsy fields and returns an empty string when nothing is set', () => {
    expect(embeddingText({ altText: null, tags: [], generatedFromPrompt: null })).toBe('');
    expect(embeddingText({ altText: 'only this', tags: [], generatedFromPrompt: null })).toBe(
      'only this',
    );
  });

  it('truncates to 2000 characters', () => {
    const text = embeddingText({
      altText: 'x'.repeat(3000),
      tags: [],
      generatedFromPrompt: null,
    });
    expect(text).toHaveLength(2_000);
  });
});

describe('vectorLiteral', () => {
  it('formats a pgvector literal', () => {
    expect(vectorLiteral([1, 0.5, -2])).toBe('[1,0.5,-2]');
  });

  it('replaces non-finite values with 0', () => {
    expect(vectorLiteral([NaN, Infinity, -Infinity, 1])).toBe('[0,0,0,1]');
  });

  it('handles an empty vector', () => {
    expect(vectorLiteral([])).toBe('[]');
  });
});

describe('ingestImage', () => {
  it('skips bytes below MIN_LONG_EDGE_PX on the long edge as too_small', async () => {
    const { deps } = fakeIngestDeps();
    const outcome = await ingestImage(deps, {
      organisationId: 'org-1',
      businessId: 'biz-1',
      source: 'UPLOAD',
      bytes: fakePng(MIN_LONG_EDGE_PX - 1, 100),
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'too_small' });
  });

  it('skips bytes that are not a recognised raster image as not_image', async () => {
    const { deps } = fakeIngestDeps();
    const outcome = await ingestImage(deps, {
      organisationId: 'org-1',
      businessId: 'biz-1',
      source: 'UPLOAD',
      bytes: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'not_image' });
  });

  it('skips bytes larger than MAX_IMAGE_BYTES as too_large', async () => {
    const { deps } = fakeIngestDeps();
    const outcome = await ingestImage(deps, {
      organisationId: 'org-1',
      businessId: 'biz-1',
      source: 'UPLOAD',
      bytes: new Uint8Array(MAX_IMAGE_BYTES + 1),
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'too_large' });
  });

  it('returns skipped/filtered when neither bytes nor a downloadUrl is given', async () => {
    const { deps } = fakeIngestDeps();
    const outcome = await ingestImage(deps, {
      organisationId: 'org-1',
      businessId: 'biz-1',
      source: 'UPLOAD',
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'filtered' });
  });

  it('returns duplicate when a row with the same fingerprint already exists', async () => {
    const { db } = fakeDb();
    (db.imageLibraryItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'existing-1',
    });
    const { storage } = memoryStorage();
    const outcome = await ingestImage(
      { db, storage, bucket: 'b', fetchImpl: vi.fn() as unknown as typeof fetch },
      {
        organisationId: 'org-1',
        businessId: 'biz-1',
        source: 'UPLOAD',
        bytes: fakePng(600, 600),
      },
    );
    expect(outcome).toEqual({ status: 'duplicate', id: 'existing-1' });
  });

  it('skips SCRAPED images whose bytes match an existing STOCK fingerprint', async () => {
    const { db } = fakeDb();
    (db.imageLibraryItem.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'stock-1',
    });
    const { storage } = memoryStorage();
    const outcome = await ingestImage(
      { db, storage, bucket: 'b', fetchImpl: vi.fn() as unknown as typeof fetch },
      {
        organisationId: 'org-1',
        businessId: 'biz-1',
        source: 'SCRAPED',
        bytes: fakePng(600, 600),
      },
    );
    expect(outcome).toEqual({ status: 'skipped', reason: 'stock_match' });
    expect(db.imageLibraryItem.findFirst).toHaveBeenCalledWith({
      where: { fingerprint: fingerprintOf(fakePng(600, 600)), source: 'STOCK' },
      select: { id: true },
    });
  });

  it('does not check the stock fingerprint for non-SCRAPED sources', async () => {
    const { db } = fakeDb();
    const { storage } = memoryStorage();
    await ingestImage(
      { db, storage, bucket: 'b', fetchImpl: vi.fn() as unknown as typeof fetch },
      {
        organisationId: 'org-1',
        businessId: 'biz-1',
        source: 'GENERATED',
        bytes: fakePng(600, 600),
      },
    );
    expect(db.imageLibraryItem.findFirst).not.toHaveBeenCalled();
  });

  it('creates a row and stores bytes under orgs/<org>/businesses/<biz>/images/<sha>.png', async () => {
    const { db } = fakeDb();
    const { storage, objects } = memoryStorage();
    const bytes = fakePng(800, 600, 1);
    const fingerprint = fingerprintOf(bytes);
    const outcome = await ingestImage(
      {
        db,
        storage,
        bucket: 'studio-library-assets',
        fetchImpl: vi.fn() as unknown as typeof fetch,
      },
      {
        organisationId: 'org-1',
        businessId: 'biz-1',
        source: 'UPLOAD',
        sourceUrl: 'https://example.com/photo.jpg',
        sourceProvider: 'manual',
        bytes,
        altText: '  fresh bread  ',
        tags: ['Bread', 'bread'],
        licenseNotes: 'owned',
      },
    );
    expect(outcome).toEqual({ status: 'created', id: 'row-1' });
    const key = `orgs/org-1/businesses/biz-1/images/${fingerprint}.png`;
    expect(objects.has(`studio-library-assets/${key}`)).toBe(true);
    expect(db.imageLibraryItem.create).toHaveBeenCalledWith({
      data: {
        organisationId: 'org-1',
        businessId: 'biz-1',
        source: 'UPLOAD',
        sourceUrl: 'https://example.com/photo.jpg',
        sourceProvider: 'manual',
        s3Bucket: 'studio-library-assets',
        s3Key: key,
        widthPx: 800,
        heightPx: 600,
        fileSizeBytes: bytes.byteLength,
        tags: ['bread'],
        altText: 'fresh bread',
        fingerprint,
        phash: null, // header-only fake PNG: not decodable, so no perceptual hash
        generatedFromPrompt: null,
        licenseNotes: 'owned',
      },
      select: { id: true },
    });
  });

  it('13.12: skips a near-duplicate (resized, re-encoded copy) of an image the business has', async () => {
    const sharp = (await import('sharp')).default;
    const { dHash } = await import('./phash');
    const width = 900;
    const height = 700;
    const raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i += 1) {
      const x = i % width;
      const y = Math.floor(i / width);
      raw[i * 3] = (x * 255) / width;
      raw[i * 3 + 1] = (y * 255) / height;
      raw[i * 3 + 2] = x > 300 && x < 600 && y > 200 && y < 400 ? 255 : 40;
    }
    const original = await sharp(raw, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();
    const copy = await sharp(original).resize(700).jpeg({ quality: 75 }).toBuffer();
    const { db, imageLibraryItem } = fakeDb();
    const existing = { id: 'img-original', phash: await dHash(original) };
    const findMany = vi.fn(async () => [existing]);
    Object.assign(imageLibraryItem, { findMany });
    const { storage, objects } = memoryStorage();
    const outcome = await ingestImage(
      { db, storage, bucket: 'b', fetchImpl: vi.fn() as unknown as typeof fetch },
      { organisationId: 'org-1', businessId: 'biz-1', source: 'SCRAPED', bytes: copy },
    );
    expect(outcome).toMatchObject({ status: 'duplicate', id: 'img-original' });
    expect((outcome as { near?: { distance: number } }).near?.distance).toBeLessThanOrEqual(6);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organisationId: 'org-1', businessId: 'biz-1', phash: { not: null } },
      }),
    );
    expect(imageLibraryItem.create).not.toHaveBeenCalled();
    expect(objects.size).toBe(0);

    // A different picture is stored, with its hash.
    findMany.mockResolvedValueOnce([{ id: 'other', phash: 'ffffffffffffffff' }]);
    const stored = await ingestImage(
      { db, storage, bucket: 'b', fetchImpl: vi.fn() as unknown as typeof fetch },
      { organisationId: 'org-1', businessId: 'biz-1', source: 'UPLOAD', bytes: original },
    );
    expect(stored).toEqual({ status: 'created', id: 'row-1' });
    const data = (
      imageLibraryItem.create.mock.calls[0] as unknown as [{ data: { phash: string } }]
    )[0].data;
    expect(data.phash).toBe(existing.phash);
  });

  it('encodes the businessId in the storage key', async () => {
    const { db } = fakeDb();
    const { storage, objects } = memoryStorage();
    await ingestImage(
      { db, storage, bucket: 'b', fetchImpl: vi.fn() as unknown as typeof fetch },
      {
        organisationId: 'org-1',
        businessId: 'biz/weird',
        source: 'UPLOAD',
        bytes: fakePng(600, 600, 2),
      },
    );
    const keys = [...objects.keys()];
    expect(keys[0]).toContain(encodeURIComponent('biz/weird'));
  });

  it('resolves a P2002 unique-constraint race by returning the winning row as a duplicate', async () => {
    const { db } = fakeDb();
    (db.imageLibraryItem.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('unique violation'), { code: 'P2002' }),
    );
    (db.imageLibraryItem.findUniqueOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'winner-42',
    });
    const { storage } = memoryStorage();
    const outcome = await ingestImage(
      { db, storage, bucket: 'b', fetchImpl: vi.fn() as unknown as typeof fetch },
      {
        organisationId: 'org-1',
        businessId: 'biz-1',
        source: 'UPLOAD',
        bytes: fakePng(600, 600, 3),
      },
    );
    expect(outcome).toEqual({ status: 'duplicate', id: 'winner-42' });
  });

  it('rethrows create() errors that are not a P2002 race', async () => {
    const { db } = fakeDb();
    const boom = new Error('db is down');
    (db.imageLibraryItem.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(boom);
    const { storage } = memoryStorage();
    await expect(
      ingestImage(
        { db, storage, bucket: 'b', fetchImpl: vi.fn() as unknown as typeof fetch },
        {
          organisationId: 'org-1',
          businessId: 'biz-1',
          source: 'UPLOAD',
          bytes: fakePng(600, 600, 4),
        },
      ),
    ).rejects.toBe(boom);
  });

  it('downloads the image when only a downloadUrl is given and ingests the fetched bytes', async () => {
    const { db } = fakeDb();
    const { storage, objects } = memoryStorage();
    const bytes = fakePng(700, 700, 5);
    const fetchImpl = vi.fn(async () => new Response(bytes, { status: 200 }));
    const outcome = await ingestImage(
      { db, storage, bucket: 'b', fetchImpl: fetchImpl as unknown as typeof fetch },
      {
        organisationId: 'org-1',
        businessId: 'biz-1',
        source: 'STOCK',
        downloadUrl: 'https://cdn.example.com/photo.jpg',
      },
    );
    expect(outcome).toEqual({ status: 'created', id: 'row-1' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(objects.size).toBe(1);
    // Confirm imageSize really does read the header of the bytes we generated.
    expect(imageSize(bytes)).toMatchObject({ width: 700, height: 700, type: 'png' });
  });

  it('returns not_image when the download responds with an HTTP error status', async () => {
    const { deps, fetchImpl } = fakeIngestDeps();
    fetchImpl.mockResolvedValue(new Response(null, { status: 404 }));
    const outcome = await ingestImage(deps, {
      organisationId: 'org-1',
      businessId: 'biz-1',
      source: 'STOCK',
      downloadUrl: 'https://cdn.example.com/missing.jpg',
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'not_image' });
  });

  it('returns too_large when the download is truncated by the byte cap', async () => {
    const { deps, fetchImpl } = fakeIngestDeps();
    fetchImpl.mockResolvedValue(new Response(new Uint8Array(MAX_IMAGE_BYTES + 2), { status: 200 }));
    const outcome = await ingestImage(deps, {
      organisationId: 'org-1',
      businessId: 'biz-1',
      source: 'STOCK',
      downloadUrl: 'https://cdn.example.com/huge.jpg',
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'too_large' });
  });
});

describe('recordHotlinkedImage', () => {
  function db() {
    const imageLibraryItem = {
      upsert: vi.fn(async () => ({ id: 'hot-1', createdAt: new Date(0) })),
    };
    return { imageLibraryItem, client: { imageLibraryItem } as unknown as PrismaClient };
  }

  it('skips images below MIN_LONG_EDGE_PX on the long edge', async () => {
    const { client } = db();
    const outcome = await recordHotlinkedImage(client, {
      organisationId: 'org-1',
      businessId: 'biz-1',
      provider: 'unsplash',
      providerImageId: 'abc',
      url: 'https://images.unsplash.com/abc',
      width: 100,
      height: 100,
      altText: null,
      tags: [],
      licenseNotes: 'Unsplash licence',
      pageUrl: null,
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'too_small' });
  });

  it('upserts a STOCK row keyed by provider:providerImageId with empty S3 fields', async () => {
    const { imageLibraryItem, client } = db();
    const outcome = await recordHotlinkedImage(client, {
      organisationId: 'org-1',
      businessId: 'biz-1',
      provider: 'unsplash',
      providerImageId: 'abc',
      url: 'https://images.unsplash.com/abc',
      width: 1600,
      height: 900,
      altText: 'a loaf',
      tags: ['Bread', 'bread'],
      licenseNotes: 'Unsplash licence',
      pageUrl: 'https://unsplash.com/photos/abc',
    });
    expect(outcome).toEqual({ status: 'created', id: 'hot-1' });
    expect(imageLibraryItem.upsert).toHaveBeenCalledWith({
      where: {
        organisationId_businessId_fingerprint: {
          organisationId: 'org-1',
          businessId: 'biz-1',
          fingerprint: 'unsplash:abc',
        },
      },
      create: {
        organisationId: 'org-1',
        businessId: 'biz-1',
        source: 'STOCK',
        sourceUrl: 'https://unsplash.com/photos/abc',
        sourceProvider: 'unsplash',
        s3Bucket: '',
        s3Key: '',
        publicUrl: 'https://images.unsplash.com/abc',
        widthPx: 1600,
        heightPx: 900,
        fileSizeBytes: 0,
        tags: ['bread'],
        altText: 'a loaf',
        fingerprint: 'unsplash:abc',
        licenseNotes: 'Unsplash licence',
      },
      update: {},
      select: { id: true, createdAt: true },
    });
  });
});
