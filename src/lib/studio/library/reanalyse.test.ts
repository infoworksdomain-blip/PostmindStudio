import { beforeEach, describe, expect, it, vi } from 'vitest';

// BACKLOG 15.D7 — re-analysis replaces the analysis + embedding of a stored source and keeps a
// staff-reviewed category. The ingest steps are mocked here; test/golden/p15-d-library.test.ts
// runs them for real through the worker.

const ingest = vi.hoisted(() => ({
  visualStructure: vi.fn(),
  analyseContent: vi.fn(),
  storeLibraryEmbedding: vi.fn(),
  embeddingDocument: vi.fn(() => 'doc'),
}));
vi.mock('./ingest', () => ingest);

import { reanalyseLibraryVideo } from './reanalyse';

const ITEM = {
  id: 'lib_1',
  title: 'Dawn bake',
  tags: ['bread'],
  categoryId: 'cat_old',
  categoryReview: null as string | null,
  s3Bucket: 'library',
  s3Key: 'library/abc.mp4',
};

function deps(item: typeof ITEM | null) {
  const upsert = vi.fn();
  const update = vi.fn();
  return {
    upsert,
    update,
    deps: {
      db: {
        videoLibraryItem: { findUnique: vi.fn(async () => item) },
        $transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) =>
          fn({ videoLibraryAnalysis: { upsert }, videoLibraryItem: { update } }),
        ),
      },
      storage: { signedUrl: vi.fn(async () => 'https://signed/abc.mp4') },
      now: () => 1_000,
    } as never,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ingest.visualStructure.mockResolvedValue({
    probe: { durationSec: 14, width: 1080, height: 1920 },
    frames: [],
    analysedShots: [],
  });
  ingest.analyseContent.mockResolvedValue({
    analysis: { description: 'New description' },
    transcript: { text: 'hello' },
    categories: new Map(),
    suggestedCategoryId: 'cat_new',
    analysisRow: { shotCount: 3 },
  });
});

describe('reanalyseLibraryVideo', () => {
  it('replaces analysis + embedding and follows the new category when unreviewed', async () => {
    const t = deps(ITEM);
    const result = await reanalyseLibraryVideo(t.deps, 'lib_1', 'STANDARD');
    expect(result).toEqual({ libraryItemId: 'lib_1', categoryChanged: true });
    expect(t.upsert).toHaveBeenCalledWith({
      where: { libraryItemId: 'lib_1' },
      create: { libraryItemId: 'lib_1', shotCount: 3 },
      update: { shotCount: 3 },
    });
    expect(t.update).toHaveBeenCalledWith({
      where: { id: 'lib_1' },
      data: expect.objectContaining({
        categoryId: 'cat_new',
        description: 'New description',
        aspectRatio: '9:16',
        reanalysedAt: new Date(1_000),
      }),
    });
    expect(ingest.storeLibraryEmbedding).toHaveBeenCalledWith(
      t.deps,
      'lib_1',
      'doc',
      'STANDARD',
      true,
    );
  });

  it('keeps a category a staff member accepted or overrode', async () => {
    for (const review of ['ACCEPTED', 'OVERRIDDEN']) {
      const t = deps({ ...ITEM, categoryReview: review });
      const result = await reanalyseLibraryVideo(t.deps, 'lib_1', 'STANDARD');
      expect(result.categoryChanged).toBe(false);
      expect(t.update.mock.calls[0]?.[0].data.categoryId).toBe('cat_old');
    }
  });

  it('fails for an unknown item', async () => {
    await expect(reanalyseLibraryVideo(deps(null).deps, 'nope', 'STANDARD')).rejects.toThrow(
      'Library video not found',
    );
  });
});
