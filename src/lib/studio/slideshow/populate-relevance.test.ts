import type { Prisma, PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../../errors';
import type { LibraryDeps } from '../images/library';
import type { StockHit, StockImageSource } from '../images/stock';
import type { ProviderRunDeps } from '../pipeline/provider-run';
import type { SlideContent } from './planner';

// BACKLOG 25.x — the whole chain with only the providers stubbed: contextual query → library miss
// → stock hits → yes/no vision check → the first fitting photo, else a generated image within the
// budget, else a text card. The real slide-images.ts and image-relevance.ts run here.

vi.mock('../images/library', () => ({
  searchLibrary: vi.fn(async () => []),
  generateLibraryImage: vi.fn(),
  storeStockHit: vi.fn(),
  embedMissing: vi.fn(async () => undefined),
}));
vi.mock('../pipeline/provider-run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pipeline/provider-run')>()),
  runProvider: vi.fn(),
}));

import { generateLibraryImage, storeStockHit } from '../images/library';
import { runProvider } from '../pipeline/provider-run';
import { MAX_RELEVANCE_CHECKS_PER_RUN } from './image-relevance';
import {
  fillSlideImages,
  MAX_GENERATIONS_PER_ORG_PER_DAY,
  type PopulateDeps,
  type PopulateScope,
} from './populate';

const runProviderMock = runProvider as unknown as ReturnType<typeof vi.fn>;
const generateMock = generateLibraryImage as unknown as ReturnType<typeof vi.fn>;
const storeMock = storeStockHit as unknown as ReturnType<typeof vi.fn>;

const scope: PopulateScope = {
  organisationId: 'org-1',
  businessId: 'biz-1',
  projectId: 'proj-1',
  planTier: 'STANDARD',
};
const gym = {
  imageThemes: ['gym', 'weights'],
  industry: 'Fitness',
  subNiche: 'Independent gym',
  products: [],
  services: ['personal training'],
};
let jpeg: Uint8Array<ArrayBuffer>;

beforeAll(async () => {
  jpeg = new Uint8Array(
    await sharp({ create: { width: 640, height: 960, channels: 3, background: '#888' } })
      .jpeg()
      .toBuffer(),
  );
});

function hit(id: string): StockHit {
  return {
    provider: 'pixabay',
    providerImageId: id,
    imageUrl: `https://cdn.pixabay.example/${id}.jpg`,
    width: 640,
    height: 960,
    alt: null,
    pageUrl: null,
    attribution: null,
    storable: true,
  };
}

function slide(id: string, text: string) {
  const content: SlideContent = { role: 'body', text, imageQuery: text };
  return {
    id,
    sortOrder: 0,
    slideType: 'IMAGE_KENBURNS',
    imageAssetId: null,
    metadata: { ...content } as Prisma.JsonObject,
    content,
  };
}

function fakeDb(generatedToday = 0) {
  const slideshowSlide = { update: vi.fn(async () => ({})) };
  const db = {
    slideshowSlide,
    businessProfile: { findFirst: vi.fn(async () => gym) },
    imageLibraryItem: {
      update: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })),
      count: vi.fn(async (args?: { where?: { businessId?: string } }) =>
        args?.where?.businessId ? 0 : generatedToday,
      ),
    },
  };
  return { db: db as unknown as PrismaClient, slideshowSlide };
}

function deps(db: PrismaClient, hits: StockHit[]) {
  const source: StockImageSource = {
    provider: 'pixabay',
    search: vi.fn(async () => hits),
    downloadUrl: vi.fn(async (h: StockHit) => h.imageUrl),
  };
  const fetchImpl = vi.fn(
    async () => new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
  ) as unknown as typeof fetch;
  const library = {
    db,
    fetchImpl,
    stock: () => ({ primary: [source], fallback: [] }),
    logger: { warn: vi.fn() },
  } as unknown as LibraryDeps;
  const populate: PopulateDeps = {
    db,
    library,
    providers: {} as unknown as ProviderRunDeps,
    reportStockUse: vi.fn(async () => undefined),
  };
  return { populate, source, fetchImpl };
}

const ok = (json: unknown) => ({ providerJobRowId: 'job', output: { metadata: { json } } });

/** Light-model stub: contextual queries, and the given yes/no answers for every photo check. */
function model(answers: Array<'yes' | 'no'> | Error) {
  runProviderMock.mockImplementation(
    async ({ request }: { request: { task: string; prompt: string; images?: unknown[] } }) => {
      if (request.task === 'slide_image_query') {
        const count = Number(/Photo slides \((\d+)\)/.exec(request.prompt)?.[1] ?? 0);
        return ok({
          queries: Array.from({ length: count }, (_, i) => ({
            slide: i + 1,
            query: `gym coach client ${i + 1}`,
          })),
        });
      }
      if (answers instanceof Error) throw answers;
      const n = request.images?.length ?? 0;
      return ok({ photos: answers.slice(0, n).map((answer, i) => ({ photo: i + 1, answer })) });
    },
  );
}

const checkCalls = () =>
  runProviderMock.mock.calls.filter((c) => c[0].request.task === 'slide_image_check').length;

beforeEach(() => {
  runProviderMock.mockReset();
  generateMock.mockReset();
  storeMock.mockReset();
  storeMock.mockImplementation(async (_d, _s, _src, h: StockHit) => ({
    status: 'created',
    id: `lib-${h.providerImageId}`,
  }));
});

const options = { topic: 'Why members stay', aspectRatio: '9:16' as const, textCardFallback: true };

describe('25.x relevance check in the slideshow image chain', () => {
  it('rejects the unrelated candidate and uses the next one that fits', async () => {
    const { db, slideshowSlide } = fakeDb();
    const { populate } = deps(db, [hit('puppies'), hit('coach'), hit('weights')]);
    model(['no', 'yes', 'yes']);

    const result = await fillSlideImages(
      populate,
      scope,
      [slide('s1', 'Coaches who know your name')],
      options,
    );

    expect(result).toMatchObject({ imagesStocked: 1, imagesGenerated: 0 });
    expect(storeMock).toHaveBeenCalledTimes(1);
    expect((storeMock.mock.calls[0]?.[3] as StockHit).providerImageId).toBe('coach');
    expect(slideshowSlide.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { imageAssetId: 'lib-coach' },
    });
    const check = runProviderMock.mock.calls.find((c) => c[0].request.task === 'slide_image_check');
    expect(check?.[0].request.prompt).toContain('gym coach client 1');
    expect(check?.[0].request.prompt).toContain('Independent gym — Fitness');
  });

  it('no candidate fits → a generated image from the contextual query', async () => {
    const { db } = fakeDb();
    const { populate } = deps(db, [hit('puppies'), hit('truck')]);
    model(['no', 'no']);
    generateMock.mockResolvedValue({ status: 'created', id: 'gen-1' });

    const result = await fillSlideImages(
      populate,
      scope,
      [slide('s1', 'Coaches who know your name')],
      options,
    );

    expect(storeMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ imagesStocked: 0, imagesGenerated: 1 });
    expect(generateMock).toHaveBeenCalledWith(expect.anything(), scope, {
      prompt: 'gym coach client 1',
      aspectRatio: '9:16',
    });
  });

  it('no candidate fits and the generation budget is spent → a text card, no AI image', async () => {
    const { db } = fakeDb(MAX_GENERATIONS_PER_ORG_PER_DAY);
    const { populate } = deps(db, [hit('puppies')]);
    model(['no']);

    const result = await fillSlideImages(
      populate,
      scope,
      [slide('s1', 'Coaches who know your name')],
      options,
    );

    expect(generateMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ imagesStocked: 0, imagesGenerated: 0, textCards: 1 });
  });

  it('a check outage never blocks: the best (first) candidate is accepted', async () => {
    const { db } = fakeDb();
    const { populate } = deps(db, [hit('first'), hit('second')]);
    model(new ProviderError('anthropic', 'server_error', 'overloaded', true));

    const result = await fillSlideImages(
      populate,
      scope,
      [slide('s1', 'Coaches who know your name')],
      options,
    );

    expect(result.imagesStocked).toBe(1);
    expect((storeMock.mock.calls[0]?.[3] as StockHit).providerImageId).toBe('first');
  });

  it('checks at most MAX_RELEVANCE_CHECKS_PER_RUN slides per slideshow, then accepts unchecked', async () => {
    const { db } = fakeDb();
    const { populate } = deps(db, [hit('a'), hit('b'), hit('c')]);
    model(['yes', 'yes', 'yes']);
    storeMock.mockImplementation(async () => ({
      status: 'created',
      id: `lib-${storeMock.mock.calls.length}`,
    }));
    const slides = Array.from({ length: MAX_RELEVANCE_CHECKS_PER_RUN + 2 }, (_, i) =>
      slide(`s${i}`, `Point ${i}`),
    );

    const result = await fillSlideImages(populate, scope, slides, options);

    expect(result.imagesStocked).toBe(slides.length);
    expect(checkCalls()).toBe(MAX_RELEVANCE_CHECKS_PER_RUN);
    // One visual-query call for the whole slideshow.
    expect(
      runProviderMock.mock.calls.filter((c) => c[0].request.task === 'slide_image_query'),
    ).toHaveLength(1);
  });
});
