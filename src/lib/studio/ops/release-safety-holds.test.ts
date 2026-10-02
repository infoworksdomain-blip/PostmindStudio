import type { PrismaClient, SafetyReview } from '@prisma/client';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../errors';
import {
  isNoProviderSafetyReview,
  NO_PROVIDER_SCAN_DETAIL,
  releaseNoProviderSafetyReview,
} from '../services/safety-reviews';
import { parseReleaseArgs, releaseSafetyHolds } from './release-safety-holds';

// BACKLOG 20.21 — scripts/ops/release-safety-holds.ts: argument parsing, which reviews count as
// "parked only for want of a provider", dry run vs real run. The release itself (DB writes, the
// gate finishing) is covered against Postgres in test/api/safety-reviews.test.ts and
// test/golden/fallback.test.ts (GF-06).

vi.mock('../services/safety-reviews', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/safety-reviews')>();
  return { ...actual, releaseNoProviderSafetyReview: vi.fn() };
});

const release = vi.mocked(releaseNoProviderSafetyReview);

function review(id: string, details: unknown, kind = 'content'): SafetyReview {
  return {
    id,
    organisationId: 'org-1',
    projectId: `p-${id}`,
    runId: `r-${id}`,
    kind,
    state: 'PENDING',
    reason: 'x',
    details,
    renderIds: [],
    planTier: 'STANDARD',
  } as unknown as SafetyReview;
}

const noProvider = (id: string) =>
  review(id, [{ renderId: 'rn', platform: 'tiktok', detail: NO_PROVIDER_SCAN_DETAIL }]);
const flagged = (id: string) =>
  review(id, [{ renderId: 'rn', platform: 'tiktok', detail: 'Needs review: knife_in_hand=0.86' }]);

function deps(rows: SafetyReview[]) {
  const findMany = vi.fn(async (_args: unknown) => rows);
  return {
    findMany,
    deps: {
      db: { safetyReview: { findMany } } as unknown as PrismaClient,
      logger: pino({ level: 'silent' }),
      audit: vi.fn(),
      now: () => Date.parse('2026-10-02T12:00:00Z'),
    },
  };
}

beforeEach(() => release.mockReset());

describe('parseReleaseArgs', () => {
  it('defaults to a real run of up to 500 reviews in every organisation', () => {
    expect(parseReleaseArgs([])).toEqual({ dryRun: false, limit: 500 });
  });

  it('reads --dry-run, --limit and --org', () => {
    expect(parseReleaseArgs(['--dry-run', '--limit', '20', '--org', 'org-9'])).toEqual({
      dryRun: true,
      limit: 20,
      organisationId: 'org-9',
    });
  });

  it.each([
    [['--limit', '0']],
    [['--limit', 'many']],
    [['--org']],
    [['--org', '--dry-run']],
    [['--apply']],
  ])('rejects %j', (argv) => {
    expect(() => parseReleaseArgs(argv)).toThrow(ValidationError);
  });
});

describe('isNoProviderSafetyReview', () => {
  it('is true only when every flagged render lacked a provider', () => {
    expect(isNoProviderSafetyReview(noProvider('a'))).toBe(true);
    expect(isNoProviderSafetyReview(flagged('b'))).toBe(false);
    expect(
      isNoProviderSafetyReview(
        review('c', [
          { renderId: 'r1', platform: 'tiktok', detail: NO_PROVIDER_SCAN_DETAIL },
          { renderId: 'r2', platform: 'x', detail: 'Needs review: yes_fight=0.9' },
        ]),
      ),
    ).toBe(false);
    expect(isNoProviderSafetyReview(review('d', []))).toBe(false);
    expect(isNoProviderSafetyReview(review('e', null))).toBe(false);
    expect(
      isNoProviderSafetyReview(review('f', [{ detail: NO_PROVIDER_SCAN_DETAIL }], 'script')),
    ).toBe(false);
  });
});

describe('releaseSafetyHolds', () => {
  it('dry run: lists the releasable reviews and changes nothing', async () => {
    const { deps: d, findMany } = deps([noProvider('a'), flagged('b'), noProvider('c')]);
    const report = await releaseSafetyHolds(d, { dryRun: true, limit: 50 });
    expect(report).toEqual({
      dryRun: true,
      pending: 3,
      releasable: ['a', 'c'],
      released: [],
      leftForStaff: 1,
      skipped: [],
    });
    expect(release).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledWith({
      where: { state: 'PENDING', kind: 'content' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 50,
    });
  });

  it('releases only the no-provider reviews and reports any that moved meanwhile', async () => {
    release.mockImplementation(async (_d, id) => (id === 'c' ? 'not_pending' : 'released'));
    const afterReady = vi.fn();
    const { deps: d, findMany } = deps([noProvider('a'), flagged('b'), noProvider('c')]);
    const report = await releaseSafetyHolds(
      { ...d, afterReady },
      { dryRun: false, limit: 10, organisationId: 'org-1' },
    );
    expect(report.released).toEqual(['a']);
    expect(report.skipped).toEqual([{ id: 'c', outcome: 'not_pending' }]);
    expect(report.leftForStaff).toBe(1);
    expect(release.mock.calls.map((c) => c[1])).toEqual(['a', 'c']);
    expect(release.mock.calls[0]?.[2]).toEqual({ afterReady });
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { state: 'PENDING', kind: 'content', organisationId: 'org-1' },
    });
  });
});
