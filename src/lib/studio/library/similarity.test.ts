import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { NotFoundError, ProviderError } from '../../errors';
import type { ProviderRunResult } from '../pipeline/provider-run';
import { profileDocument, recommendedVideos, similarVideos } from './similarity';

// BACKLOG 9.4 / Addendum A3.5 — pgvector nearest-neighbour search over the library.

vi.mock('../pipeline/provider-run', () => ({ runProvider: vi.fn() }));
// Unit tests use a fake $queryRaw: resolve pgvector to the "studio" schema without a lookup.
vi.mock('../vector-sql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../vector-sql')>();
  return { ...actual, vectorSql: async () => actual.vectorSqlFor('studio') };
});
import { runProvider } from '../pipeline/provider-run';

const runProviderMock = runProvider as unknown as ReturnType<typeof vi.fn>;

function fakeDb() {
  const businessProfile = { findFirst: vi.fn(async (): Promise<unknown> => null) };
  const videoLibraryItem = { findFirst: vi.fn(async (): Promise<unknown> => null) };
  const db = {
    businessProfile,
    videoLibraryItem,
    $queryRaw: vi.fn(async () => []),
  };
  return { db: db as unknown as PrismaClient, businessProfile, videoLibraryItem };
}

describe('profileDocument', () => {
  it('joins the sub-niche/industry header with every non-empty list and the voice summary', () => {
    const doc = profileDocument({
      industry: 'Food',
      subNiche: 'Artisan bakery',
      products: ['sourdough'],
      services: [],
      audienceKeywords: ['locals', 'foodies'],
      toneIndicators: [],
      imageThemes: ['bread'],
      brandVoiceSummary: 'Warm and playful',
    });
    expect(doc).toBe(
      [
        'Artisan bakery (Food)',
        'Products: sourdough',
        'Audience: locals, foodies',
        'Themes: bread',
        'Warm and playful',
      ].join('\n'),
    );
  });

  it('omits every empty list and a null voice summary entirely', () => {
    const doc = profileDocument({
      industry: 'Food',
      subNiche: 'Bakery',
      products: [],
      services: [],
      audienceKeywords: [],
      toneIndicators: [],
      imageThemes: [],
      brandVoiceSummary: null,
    });
    expect(doc).toBe('Bakery (Food)');
  });
});

describe('similarVideos', () => {
  it('maps distance to a 1-distance similarity score for the returned rows', async () => {
    const { db } = fakeDb();
    (db.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'row-1', distance: 0.2 },
      { id: 'row-2', distance: 0 },
    ]);
    const hits = await similarVideos(db, 'lib-1', 5);
    expect(hits).toEqual([
      { id: 'row-1', similarity: 0.8 },
      { id: 'row-2', similarity: 1 },
    ]);
  });

  it('throws NotFoundError when there are no rows and the source item itself is missing', async () => {
    const { db, videoLibraryItem } = fakeDb();
    (db.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    videoLibraryItem.findFirst.mockResolvedValue(null);
    await expect(similarVideos(db, 'missing', 5)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns an empty array (no error) when there are no rows but the source item exists', async () => {
    const { db, videoLibraryItem } = fakeDb();
    (db.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    videoLibraryItem.findFirst.mockResolvedValue({ id: 'lib-1' });
    await expect(similarVideos(db, 'lib-1', 5)).resolves.toEqual([]);
  });
});

const scope = { organisationId: 'org-1', businessId: 'biz-1', planTier: 'STANDARD' as const };
const EMBEDDING_DIMENSIONS = 1536;

describe('recommendedVideos', () => {
  it('throws NotFoundError when there is no business profile yet', async () => {
    const { db } = fakeDb();
    await expect(
      recommendedVideos({ db, providers: {} as never }, scope, { limit: 5 }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(runProviderMock).not.toHaveBeenCalled();
  });

  it('throws a ProviderError when the embedding has the wrong dimensions', async () => {
    const { db, businessProfile } = fakeDb();
    businessProfile.findFirst.mockResolvedValue({
      industry: 'Food',
      subNiche: 'Bakery',
      products: [],
      services: [],
      audienceKeywords: [],
      toneIndicators: [],
      imageThemes: [],
      brandVoiceSummary: null,
    });
    runProviderMock.mockResolvedValue({
      decision: { adapter: { providerId: 'openai' } },
      providerJobRowId: 'job-1',
      output: { metadata: { embeddings: [[0.1, 0.2]] } },
    } as unknown as ProviderRunResult);
    await expect(
      recommendedVideos({ db, providers: {} as never }, scope, { limit: 5 }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('embeds the profile and returns similarity-mapped rows, matching every category when none is given', async () => {
    const { db, businessProfile } = fakeDb();
    businessProfile.findFirst.mockResolvedValue({
      industry: 'Food',
      subNiche: 'Bakery',
      products: [],
      services: [],
      audienceKeywords: [],
      toneIndicators: [],
      imageThemes: [],
      brandVoiceSummary: null,
    });
    runProviderMock.mockResolvedValue({
      decision: { adapter: { providerId: 'openai' } },
      providerJobRowId: 'job-1',
      output: { metadata: { embeddings: [new Array(EMBEDDING_DIMENSIONS).fill(0.1)] } },
    } as unknown as ProviderRunResult);
    const queryRaw = db.$queryRaw as unknown as ReturnType<typeof vi.fn>;
    queryRaw.mockResolvedValue([{ id: 'row-1', distance: 0.3 }]);

    const hits = await recommendedVideos({ db, providers: {} as never }, scope, { limit: 3 });
    expect(hits).toEqual([{ id: 'row-1', similarity: 0.7 }]);
    // No categorySlug: the `all` bind is true, so the category predicate matches everything.
    const sqlArgs = queryRaw.mock.calls[0] as unknown[];
    expect(sqlArgs.some((arg) => arg === true)).toBe(true);
  });

  it('escapes %, _ and backslash out of a supplied categorySlug before building the exact and child matches', async () => {
    const { db, businessProfile } = fakeDb();
    businessProfile.findFirst.mockResolvedValue({
      industry: 'Food',
      subNiche: 'Bakery',
      products: [],
      services: [],
      audienceKeywords: [],
      toneIndicators: [],
      imageThemes: [],
      brandVoiceSummary: null,
    });
    runProviderMock.mockResolvedValue({
      decision: { adapter: { providerId: 'openai' } },
      providerJobRowId: 'job-1',
      output: { metadata: { embeddings: [new Array(EMBEDDING_DIMENSIONS).fill(0.1)] } },
    } as unknown as ProviderRunResult);
    const queryRaw = db.$queryRaw as unknown as ReturnType<typeof vi.fn>;
    queryRaw.mockResolvedValue([]);

    await recommendedVideos({ db, providers: {} as never }, scope, {
      limit: 3,
      categorySlug: '10%_off\\special',
    });
    const sqlArgs = queryRaw.mock.calls[0] as unknown[];
    // Exact slug or a child ('slug/…'): a sibling that merely shares the prefix never matches.
    expect(sqlArgs.some((arg) => arg === '10offspecial')).toBe(true);
    expect(sqlArgs.some((arg) => arg === '10offspecial/%')).toBe(true);
    expect(sqlArgs.some((arg) => arg === '10offspecial%')).toBe(false);
  });
});
