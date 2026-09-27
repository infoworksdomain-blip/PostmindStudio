import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { memoryStorage } from '../../../../test/helpers/memory-storage';
import { ValidationError } from '../../errors';
import { resolveSlides } from './resolve';

const project = { id: 'proj-1', organisationId: 'org-1', businessId: 'biz-1' };

interface SlideRow {
  id: string;
  sortOrder: number;
  slideType: string;
  imageAssetId: string | null;
  videoAssetId: string | null;
  backgroundColor: string | null;
  durationSec: number;
  transitionIn: string | null;
  kenBurnsSpec: unknown;
  metadata: Record<string, unknown>;
}

interface ImageRow {
  id: string;
  organisationId: string;
  businessId: string;
  s3Bucket: string;
  s3Key: string;
  publicUrl: string | null;
}

interface VideoRow {
  id: string;
  organisationId: string;
  projectId: string;
  s3Bucket: string;
  s3Key: string;
}

interface ProjectRow {
  id: string;
  organisationId: string;
  businessId: string;
  deletedAt: string | null;
}

function fakeDb(
  slides: SlideRow[],
  images: ImageRow[] = [],
  videos: VideoRow[] = [],
  projects: ProjectRow[] = [],
) {
  const slideshowSlide = { findMany: vi.fn(async () => slides) };
  const imageLibraryItem = {
    findMany: vi.fn(
      async ({
        where,
      }: {
        where: { id: { in: string[] }; organisationId: string; businessId: string };
      }) =>
        images.filter(
          (i) =>
            where.id.in.includes(i.id) &&
            i.organisationId === where.organisationId &&
            i.businessId === where.businessId,
        ),
    ),
  };
  const videoAsset = {
    findMany: vi.fn(
      async ({ where }: { where: { id: { in: string[] }; organisationId: string } }) =>
        videos.filter(
          (v) => where.id.in.includes(v.id) && v.organisationId === where.organisationId,
        ),
    ),
  };
  const videoProject = {
    findMany: vi.fn(
      async ({
        where,
      }: {
        where: {
          id: { in: string[] };
          organisationId: string;
          businessId: string;
          deletedAt: null;
        };
      }) =>
        projects.filter(
          (p) =>
            where.id.in.includes(p.id) &&
            p.organisationId === where.organisationId &&
            p.businessId === where.businessId &&
            p.deletedAt === where.deletedAt,
        ),
    ),
  };
  return { slideshowSlide, imageLibraryItem, videoAsset, videoProject } as unknown as PrismaClient;
}

function slide(overrides: Partial<SlideRow>): SlideRow {
  return {
    id: 's-1',
    sortOrder: 0,
    slideType: 'IMAGE_STILL',
    imageAssetId: null,
    videoAssetId: null,
    backgroundColor: null,
    durationSec: 2,
    transitionIn: 'fade',
    kenBurnsSpec: null,
    metadata: {},
    ...overrides,
  };
}

describe('resolveSlides', () => {
  it('resolves a stored image via a signed URL', async () => {
    const { storage } = memoryStorage();
    const db = fakeDb(
      [slide({ imageAssetId: 'img-1' })],
      [
        {
          id: 'img-1',
          organisationId: 'org-1',
          businessId: 'biz-1',
          s3Bucket: 'assets',
          s3Key: 'a.jpg',
          publicUrl: null,
        },
      ],
    );
    const [resolved] = await resolveSlides({ db, storage }, project);
    expect(resolved?.imageSrc).toBe('https://signed.example/assets/a.jpg');
  });

  it('uses the hotlink publicUrl for an image with an empty s3Key', async () => {
    const { storage } = memoryStorage();
    const db = fakeDb(
      [slide({ imageAssetId: 'img-1' })],
      [
        {
          id: 'img-1',
          organisationId: 'org-1',
          businessId: 'biz-1',
          s3Bucket: '',
          s3Key: '',
          publicUrl: 'https://images.unsplash.com/abc',
        },
      ],
    );
    const [resolved] = await resolveSlides({ db, storage }, project);
    expect(resolved?.imageSrc).toBe('https://images.unsplash.com/abc');
  });

  it('resolves before/after image ids from the slide content', async () => {
    const { storage } = memoryStorage();
    const db = fakeDb(
      [
        slide({
          slideType: 'BEFORE_AFTER',
          metadata: { beforeImageId: 'b-1', afterImageId: 'a-1' },
        }),
      ],
      [
        {
          id: 'b-1',
          organisationId: 'org-1',
          businessId: 'biz-1',
          s3Bucket: 'assets',
          s3Key: 'before.jpg',
          publicUrl: null,
        },
        {
          id: 'a-1',
          organisationId: 'org-1',
          businessId: 'biz-1',
          s3Bucket: 'assets',
          s3Key: 'after.jpg',
          publicUrl: null,
        },
      ],
    );
    const [resolved] = await resolveSlides({ db, storage }, project);
    expect(resolved?.beforeSrc).toBe('https://signed.example/assets/before.jpg');
    expect(resolved?.afterSrc).toBe('https://signed.example/assets/after.jpg');
  });

  it('resolves a video asset via a signed URL', async () => {
    const { storage } = memoryStorage();
    const db = fakeDb(
      [slide({ slideType: 'VIDEO_CLIP', videoAssetId: 'vid-1' })],
      [],
      [
        {
          id: 'vid-1',
          organisationId: 'org-1',
          projectId: 'proj-src-1',
          s3Bucket: 'renders',
          s3Key: 'v.mp4',
        },
      ],
      [{ id: 'proj-src-1', organisationId: 'org-1', businessId: 'biz-1', deletedAt: null }],
    );
    const [resolved] = await resolveSlides({ db, storage }, project);
    expect(resolved?.videoSrc).toBe('https://signed.example/renders/v.mp4');
  });

  it('throws ValidationError when a referenced image asset is missing (org-scoped lookup failed)', async () => {
    const { storage } = memoryStorage();
    const db = fakeDb([slide({ sortOrder: 2, imageAssetId: 'missing-img' })], []);
    await expect(resolveSlides({ db, storage }, project)).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError with a 1-based slide number in the message', async () => {
    const { storage } = memoryStorage();
    const db = fakeDb([slide({ sortOrder: 2, imageAssetId: 'missing-img' })], []);
    await expect(resolveSlides({ db, storage }, project)).rejects.toThrow(/Slide 3/);
  });

  it('throws ValidationError when a referenced video asset is missing', async () => {
    const { storage } = memoryStorage();
    const db = fakeDb(
      [slide({ slideType: 'VIDEO_CLIP', videoAssetId: 'missing-vid' })],
      [],
      [],
      [],
    );
    await expect(resolveSlides({ db, storage }, project)).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError when the video asset belongs to a project of a different business', async () => {
    const { storage } = memoryStorage();
    const db = fakeDb(
      [slide({ slideType: 'VIDEO_CLIP', videoAssetId: 'vid-1' })],
      [],
      [
        {
          id: 'vid-1',
          organisationId: 'org-1',
          projectId: 'proj-other-biz',
          s3Bucket: 'renders',
          s3Key: 'v.mp4',
        },
      ],
      [{ id: 'proj-other-biz', organisationId: 'org-1', businessId: 'biz-2', deletedAt: null }],
    );
    await expect(resolveSlides({ db, storage }, project)).rejects.toBeInstanceOf(ValidationError);
  });

  it('parses a valid kenBurnsSpec into kenBurnsEffect', async () => {
    const { storage } = memoryStorage();
    const db = fakeDb(
      [
        slide({
          slideType: 'IMAGE_KENBURNS',
          imageAssetId: 'img-1',
          kenBurnsSpec: { effect: 'zoomOut' },
        }),
      ],
      [
        {
          id: 'img-1',
          organisationId: 'org-1',
          businessId: 'biz-1',
          s3Bucket: 'assets',
          s3Key: 'a.jpg',
          publicUrl: null,
        },
      ],
    );
    const [resolved] = await resolveSlides({ db, storage }, project);
    expect(resolved?.kenBurnsEffect).toBe('zoomOut');
  });

  it('leaves kenBurnsEffect undefined for an invalid or missing kenBurnsSpec', async () => {
    const { storage } = memoryStorage();
    const db = fakeDb(
      [
        slide({
          slideType: 'IMAGE_KENBURNS',
          imageAssetId: 'img-1',
          kenBurnsSpec: { effect: 'not-a-real-effect' },
        }),
      ],
      [
        {
          id: 'img-1',
          organisationId: 'org-1',
          businessId: 'biz-1',
          s3Bucket: 'assets',
          s3Key: 'a.jpg',
          publicUrl: null,
        },
      ],
    );
    const [resolved] = await resolveSlides({ db, storage }, project);
    expect(resolved?.kenBurnsEffect).toBeUndefined();
  });

  it('does not resolve an image or video from another organisation', async () => {
    const { storage } = memoryStorage();
    const db = fakeDb(
      [slide({ imageAssetId: 'img-other-org' })],
      [
        {
          id: 'img-other-org',
          organisationId: 'org-2',
          businessId: 'biz-1',
          s3Bucket: 'assets',
          s3Key: 'a.jpg',
          publicUrl: null,
        },
      ],
    );
    await expect(resolveSlides({ db, storage }, project)).rejects.toBeInstanceOf(ValidationError);
  });

  it('returns slides ordered as findMany provides them, carrying through basic fields', async () => {
    const { storage } = memoryStorage();
    const db = fakeDb([
      slide({
        id: 's-1',
        sortOrder: 0,
        slideType: 'TEXT_CARD',
        backgroundColor: '#112233',
        durationSec: 3,
        transitionIn: 'zoom',
        metadata: { text: 'hi' },
      }),
    ]);
    const [resolved] = await resolveSlides({ db, storage }, project);
    expect(resolved).toMatchObject({
      slideType: 'TEXT_CARD',
      durationSec: 3,
      transitionIn: 'zoom',
      backgroundColor: '#112233',
      content: { text: 'hi' },
    });
  });

  it('parses invalid slide metadata into {} via parseSlideContent', async () => {
    const { storage } = memoryStorage();
    const db = fakeDb([
      slide({ metadata: { unknownField: 'x' } as unknown as Record<string, unknown> }),
    ]);
    const [resolved] = await resolveSlides({ db, storage }, project);
    expect(resolved?.content).toEqual({});
  });
});
