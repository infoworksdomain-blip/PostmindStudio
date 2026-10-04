import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, RateLimitError, ValidationError } from '../../errors';
import type { JobQueue } from '../queue/enqueue';
import type { AssetStorage } from '../storage';
import type { ProviderRunDeps } from '../pipeline/provider-run';
import type { TenantContext } from '../../tenant';

const generate = vi.fn();
vi.mock('../carousel/writer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../carousel/writer')>()),
  projectTextGenerator: () => generate,
  loadThreadContext: async () => ({
    language: 'en-GB',
    facts: { businessName: 'Acme' },
    voice: [],
    restrictedTopics: [],
  }),
}));

const {
  carouselDownload,
  getCarousel,
  handleFromName,
  initialCarousel,
  MAX_CAROUSEL_REWRITES,
  rerenderCarousel,
  rewriteCarousel,
  saveCarousel,
} = await import('./carousels');

const carousel = (over: Record<string, unknown> = {}) => ({
  version: 1,
  theme: 'light',
  language: 'en-GB',
  profile: { displayName: 'Acme', handle: 'acme', logoUploadId: null },
  posts: [
    { id: 'p1', text: 'Hook', image: null },
    { id: 'p2', text: 'Body', image: null },
    { id: 'p3', text: 'Follow', image: null },
  ],
  postCount: 3,
  aiWritten: false,
  rewrites: 0,
  ...over,
});

const project = (over: Record<string, unknown> = {}) => ({
  id: 'prj_1',
  organisationId: 'org_1',
  businessId: 'biz_1',
  brandKitId: null,
  sourceType: 'CAROUSEL',
  state: 'READY_FOR_REVIEW',
  description: 'Bread tips',
  errorReason: null,
  language: 'en-GB',
  updatedAt: new Date('2026-10-04T10:00:00Z'),
  metadata: { carousel: carousel(), renders: { s1: 'r1' } },
  ...over,
});

const composition = {
  kind: 'carousel',
  version: 1,
  bucket: 'renders',
  theme: 'light',
  language: 'en-GB',
  aiGenerated: false,
  slides: [
    {
      index: 0,
      pngKey: 'a.png',
      jpegKey: 'a.jpg',
      width: 1080,
      height: 1350,
      altText: 'Hook',
      postIds: ['p1'],
    },
  ],
  issues: [],
};

function makeDb(p: Record<string, unknown> = project(), renders = 1) {
  return {
    videoProject: {
      findFirst: vi.fn(async () => p),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    videoRender: {
      findFirst: vi.fn(async () =>
        renders
          ? { id: 'r1', qualityCheckState: 'PASSED', createdAt: new Date(0), composition }
          : null,
      ),
      count: vi.fn(async () => renders),
    },
    imageLibraryItem: { findMany: vi.fn(async () => []) },
    business: { findFirst: vi.fn(async () => ({ name: 'Café Lune & Co' })) },
    platformConnection: { findMany: vi.fn(async () => []) },
    brandKit: { findFirst: vi.fn(async () => ({ logoAssetId: 'logo_1' })) },
  };
}

const storage = {
  put: vi.fn(async (i: { bucket: string; key: string }) => ({ ...i, url: '' })),
  signedUrl: vi.fn(async (_b: string, key: string) => `https://signed/${key}`),
  size: vi.fn(async () => 3),
  readRange: vi.fn(async () => new Uint8Array([1, 2, 3])),
  delete: vi.fn(),
} as unknown as AssetStorage;

const tenant = {
  organisationId: 'org_1',
  organisation: { planTier: 'standard' },
} as unknown as TenantContext;

/** The first argument of a mock's n-th call. */
function firstArg(fn: { mock: { calls: unknown[] } }, n: number): unknown {
  return (fn.mock.calls[n] as unknown[] | undefined)?.[0];
}

beforeEach(() => generate.mockReset());

describe('handles', () => {
  it('makes a handle from the business name', () => {
    expect(handleFromName('Café Lune & Co')).toBe('cafeluneco');
  });

  it('starts a carousel with the business name, logo, a handle and pasted posts', async () => {
    const db = makeDb();
    db.platformConnection.findMany.mockResolvedValue([
      { platform: 'tiktok', platformAccountName: 'Café Lune' },
      { platform: 'instagram', platformAccountName: '@cafe.lune' },
    ] as never);
    const started = await initialCarousel(db as unknown as PrismaClient, {
      organisationId: 'org_1',
      businessId: 'biz_1',
      language: 'fr',
      carousel: { theme: 'dark', postCount: 7, thread: 'One\n---\nTwo\n---\nThree' },
    });
    expect(started.profile).toEqual({
      displayName: 'Café Lune & Co',
      handle: 'cafe.lune',
      logoUploadId: 'logo_1',
    });
    expect(started.posts.map((p) => p.text)).toEqual(['One', 'Two', 'Three']);
    expect(started).toMatchObject({ theme: 'dark', language: 'fr', postCount: 3, rewrites: 0 });
  });

  it('keeps the owner’s handle and the requested post count when nothing is pasted', async () => {
    const started = await initialCarousel(makeDb() as unknown as PrismaClient, {
      organisationId: 'org_1',
      businessId: 'biz_1',
      language: 'en-GB',
      carousel: { theme: 'light', postCount: 5, handle: 'mine' },
    });
    expect(started).toMatchObject({ posts: [], postCount: 5, profile: { handle: 'mine' } });
  });
});

describe('getCarousel', () => {
  it('returns the carousel, its latest render and what can be done', async () => {
    const view = await getCarousel(
      { db: makeDb() as unknown as PrismaClient, storage },
      'org_1',
      'prj_1',
    );
    expect(view).toMatchObject({
      editable: true,
      canRerender: true,
      rewritesLeft: MAX_CAROUSEL_REWRITES,
    });
    expect(view.render?.slides).toEqual([
      { index: 0, pngUrl: 'https://signed/a.png', postIds: ['p1'] },
    ]);
  });

  it('refuses a project that is not a carousel', async () => {
    const db = makeDb(project({ sourceType: 'BRIEF', metadata: {} }));
    await expect(
      getCarousel({ db: db as unknown as PrismaClient, storage }, 'org_1', 'prj_1'),
    ).rejects.toThrow(ConflictError);
  });
});

describe('saveCarousel', () => {
  const edit = {
    theme: 'dark' as const,
    profile: { displayName: 'Acme', handle: 'acme' },
    posts: [{ id: 'p1', text: 'New hook', imageId: null }],
  };

  it('stores the edit on the project', async () => {
    const db = makeDb();
    await saveCarousel({ db: db as unknown as PrismaClient, storage }, 'org_1', 'prj_1', edit);
    const data = firstArg(db.videoProject.updateMany, 0) as {
      data: { metadata: { carousel: { theme: string; posts: unknown[] } } };
    };
    expect(data.data.metadata.carousel.theme).toBe('dark');
    expect(data.data.metadata.carousel.posts).toEqual([
      { id: 'p1', text: 'New hook', image: null },
    ]);
  });

  it('refuses edits while the project is approved', async () => {
    const db = makeDb(project({ state: 'APPROVED' }));
    await expect(
      saveCarousel({ db: db as unknown as PrismaClient, storage }, 'org_1', 'prj_1', edit),
    ).rejects.toThrow(ConflictError);
  });

  it('refuses pictures that are not in the business’s library', async () => {
    await expect(
      saveCarousel({ db: makeDb() as unknown as PrismaClient, storage }, 'org_1', 'prj_1', {
        ...edit,
        posts: [{ id: 'p1', text: 'x', imageId: 'foreign' }],
      }),
    ).rejects.toThrow(ValidationError);
  });
});

describe('rerenderCarousel', () => {
  it('queues a render with a new run, without a generation', async () => {
    const db = makeDb();
    const queue = { add: vi.fn(async () => undefined) } as unknown as JobQueue;
    const run = await rerenderCarousel(
      { db: db as unknown as PrismaClient, queue },
      tenant,
      'prj_1',
    );
    expect(run.runId).toEqual(expect.any(String));
    expect(queue.add).toHaveBeenCalledWith(
      'render-carousel',
      expect.objectContaining({ projectId: 'prj_1', runId: run.runId, planTier: 'STANDARD' }),
      expect.objectContaining({ jobId: `render-carousel__prj_1__${run.runId}` }),
    );
    const update = firstArg(db.videoProject.updateMany, 0) as { data: { state: string } };
    expect(update.data.state).toBe('ASSETS_QUEUED');
  });

  it('needs an earlier render (a first render comes from Generate)', async () => {
    const queue = { add: vi.fn() } as unknown as JobQueue;
    await expect(
      rerenderCarousel(
        { db: makeDb(project(), 0) as unknown as PrismaClient, queue },
        tenant,
        'prj_1',
      ),
    ).rejects.toThrow('Generate the carousel first');
  });

  it('puts the project back when the queue is down', async () => {
    const db = makeDb();
    const queue = {
      add: vi.fn(async () => Promise.reject(new Error('redis down'))),
    } as unknown as JobQueue;
    await expect(
      rerenderCarousel({ db: db as unknown as PrismaClient, queue }, tenant, 'prj_1'),
    ).rejects.toThrow('could not be queued');
    expect(db.videoProject.updateMany).toHaveBeenCalledTimes(2);
  });
});

describe('rewriteCarousel', () => {
  const deps = (db: ReturnType<typeof makeDb>) => ({
    db: db as unknown as PrismaClient,
    storage,
    providers: {} as ProviderRunDeps,
    now: () => 0,
  });

  it('rewrites one post and counts the rewrite', async () => {
    generate.mockResolvedValue({ text: 'Better hook' });
    const db = makeDb();
    await rewriteCarousel(deps(db), tenant, 'prj_1', { postId: 'p1' });
    const update = firstArg(db.videoProject.updateMany, 0) as {
      data: {
        metadata: {
          carousel: { posts: Array<{ text: string }>; rewrites: number; aiWritten: boolean };
        };
      };
    };
    expect(update.data.metadata.carousel.posts.map((p) => p.text)).toEqual([
      'Better hook',
      'Body',
      'Follow',
    ]);
    expect(update.data.metadata.carousel).toMatchObject({ rewrites: 1, aiWritten: true });
  });

  it('rewrites the whole thread keeping post ids and pictures by position', async () => {
    generate.mockResolvedValue({
      actionable: true,
      directionOptions: [],
      restrictedTopicsMentioned: [],
      hookFramework: 'direct_you',
      posts: [
        { text: 'You need this', imageQuery: 'bread' },
        { text: 'Tip', imageQuery: '' },
        { text: 'Save it', imageQuery: '' },
      ],
    });
    const db = makeDb();
    await rewriteCarousel(deps(db), tenant, 'prj_1', {});
    const update = firstArg(db.videoProject.updateMany, 0) as {
      data: { metadata: { carousel: { posts: Array<{ id: string; text: string }> } } };
    };
    expect(update.data.metadata.carousel.posts.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(update.data.metadata.carousel.posts[0]?.text).toBe('You need this');
  });

  it('stops after the rewrite allowance', async () => {
    const db = makeDb(
      project({ metadata: { carousel: carousel({ rewrites: MAX_CAROUSEL_REWRITES }) } }),
    );
    await expect(rewriteCarousel(deps(db), tenant, 'prj_1', { postId: 'p1' })).rejects.toThrow(
      RateLimitError,
    );
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('carouselDownload', () => {
  it('zips the slides next to them and returns a signed URL', async () => {
    const result = await carouselDownload(
      { db: makeDb() as unknown as PrismaClient, storage },
      'org_1',
      'prj_1',
    );
    expect(result.fileName).toBe('carousel-prj_1.zip');
    expect(result.url).toMatch(/^https:\/\/signed\/.*orgs\/org_1\/projects\/prj_1\/.*r1\.zip$/);
    expect(storage.put).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'renders', contentType: 'application/zip' }),
    );
  });
});
