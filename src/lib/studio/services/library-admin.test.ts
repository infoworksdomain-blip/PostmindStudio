import { describe, expect, it, vi } from 'vitest';
import {
  adminListQuery,
  bulkInput,
  bulkReviewLibraryVideos,
  licenceAudit,
  licenceStatus,
  queueReanalysis,
  reanalyseInput,
} from './library-admin';

// BACKLOG 15.D7 — unit tests for the staff library service (DB behaviour: test/api).

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('licenceStatus', () => {
  it('classifies missing, open-ended, expired and soon-expiring licences', () => {
    expect(licenceStatus(null, NOW)).toBe('missing');
    expect(licenceStatus({ licenseExpires: null }, NOW)).toBe('ok');
    expect(licenceStatus({ licenseExpires: new Date(NOW) }, NOW)).toBe('expired');
    expect(licenceStatus({ licenseExpires: new Date(NOW + 29 * DAY) }, NOW)).toBe('expiring');
    expect(licenceStatus({ licenseExpires: new Date(NOW + 31 * DAY) }, NOW)).toBe('ok');
  });
});

describe('inputs', () => {
  it('parses list filters and bounds the page', () => {
    expect(adminListQuery.parse({ licence: 'missing', retired: 'true' })).toMatchObject({
      licence: 'missing',
      retired: 'true',
      limit: 25,
    });
    expect(adminListQuery.safeParse({ licence: 'PIRATED' }).success).toBe(false);
    expect(adminListQuery.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('requires a category for override only, and one form of it', () => {
    expect(bulkInput.safeParse({ ids: ['a'], action: 'accept' }).success).toBe(true);
    expect(bulkInput.safeParse({ ids: ['a'], action: 'override' }).success).toBe(false);
    expect(bulkInput.safeParse({ ids: ['a'], action: 'override', category: 'x/y' }).success).toBe(
      true,
    );
    expect(
      bulkInput.safeParse({ ids: ['a'], action: 'override', category: 'x', categoryId: 'c' })
        .success,
    ).toBe(false);
    expect(bulkInput.safeParse({ ids: ['a'], action: 'reject', categoryId: 'c' }).success).toBe(
      false,
    );
  });

  it('de-duplicates ids and caps them at 100', () => {
    expect(reanalyseInput.parse({ ids: ['a', 'a', 'b'] }).ids).toEqual(['a', 'b']);
    expect(reanalyseInput.safeParse({ ids: Array.from({ length: 101 }, String) }).success).toBe(
      false,
    );
  });
});

function fakeDb(existing: string[]) {
  const updateMany = vi.fn(async (args: { where: { retiredAt?: null } }) => ({
    count: args.where.retiredAt === null ? 1 : existing.length,
  }));
  const db = {
    videoLibraryItem: {
      findMany: vi.fn(async () => existing.map((id) => ({ id }))),
      updateMany,
      count: vi.fn(async () => 3),
    },
    videoLibraryCategory: { findFirst: vi.fn(async () => ({ id: 'cat_new' })) },
    videoLibraryLicense: {
      groupBy: vi.fn(async () => [{ scenario: 'OWNED', _count: { _all: 7 } }]),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ videoLibraryItem: { updateMany } }),
    ),
  };
  return { db, updateMany };
}

describe('bulkReviewLibraryVideos', () => {
  it('overrides the category of the ids that exist and reports the rest', async () => {
    const { db, updateMany } = fakeDb(['a']);
    const result = await bulkReviewLibraryVideos(
      { db: db as never, now: () => NOW },
      { ids: ['a', 'b'], action: 'override', category: 'food' },
    );
    expect(result).toEqual({
      action: 'override',
      updated: ['a'],
      missing: ['b'],
      retired: 0,
      categoryId: 'cat_new',
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a'] } },
      data: { categoryReview: 'OVERRIDDEN', categoryReviewedAt: new Date(NOW), categoryId: 'cat_new' },
    });
  });

  it('retires on reject', async () => {
    const { db, updateMany } = fakeDb(['a']);
    const result = await bulkReviewLibraryVideos(
      { db: db as never, now: () => NOW },
      { ids: ['a'], action: 'reject' },
    );
    expect(result.retired).toBe(1);
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: { in: ['a'] }, retiredAt: null },
      data: { retiredAt: new Date(NOW) },
    });
  });

  it('fails when no id exists', async () => {
    const { db } = fakeDb([]);
    await expect(
      bulkReviewLibraryVideos({ db: db as never, now: () => NOW }, { ids: ['x'], action: 'accept' }),
    ).rejects.toThrow('None of these library videos exist');
  });
});

describe('queueReanalysis', () => {
  it('enqueues one low-priority platform job per known item', async () => {
    const { db } = fakeDb(['a']);
    const add = vi.fn(async () => undefined);
    const result = await queueReanalysis(
      { db: db as never, queue: { add }, now: () => NOW },
      { ids: ['a', 'zz'] },
      'STANDARD',
    );
    expect(result).toEqual({
      queued: [{ id: 'a', jobId: `reanalyse-library-video__a__${NOW}` }],
      skipped: [{ id: 'zz', reason: 'unknown' }],
    });
    expect(add).toHaveBeenCalledWith(
      'reanalyse-library-video',
      expect.objectContaining({ libraryItemId: 'a', batch: true, planTier: 'STANDARD' }),
      { jobId: `reanalyse-library-video__a__${NOW}` },
    );
  });
});

describe('licenceAudit', () => {
  it('fills every scenario and flags truncated problem lists', async () => {
    const { db } = fakeDb([]);
    const audit = await licenceAudit({ db: db as never, now: () => NOW }, { limit: 0 });
    expect(audit.byScenario).toEqual({ LICENSED: 0, OWNED: 7, SCRAPED: 0, NOT_REQUIRED: 0 });
    expect(audit).toMatchObject({ missing: 3, expired: 3, expiringSoon: 3, problems: [] });
    expect(audit.problemsTruncated).toBe(true);
  });
});
