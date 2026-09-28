import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  failedChecksOf,
  forceApprovalsQuery,
  listForceApprovals,
  MAX_ROWS,
  parseOverride,
} from './force-approvals';

// BACKLOG 15.D5 — force-approve review rows from video_renders (spec 13.5).

const NOW = Date.parse('2026-09-28T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const failed = { code: 'loudness', status: 'failed', severity: 'error', detail: '-24 LUFS' };
const passed = { code: 'duration', status: 'passed', severity: 'info', detail: 'ok' };

function row(id: string, createdAt: number, issues: unknown) {
  return {
    id,
    targetPlatform: 'tiktok',
    aspectRatio: '9:16',
    createdAt: new Date(createdAt),
    qualityIssues: issues,
    project: {
      id: `prj_${id}`,
      name: 'Launch',
      state: 'APPROVED',
      businessId: 'biz_1',
      organisationId: 'org_1',
    },
  };
}

function fakeDb(rows: unknown[]) {
  const calls: unknown[] = [];
  const db = {
    videoRender: {
      findMany: async (args: unknown) => {
        calls.push(args);
        return rows;
      },
    },
  } as unknown as Pick<PrismaClient, 'videoRender'>;
  return { db, calls };
}

describe('parseOverride', () => {
  it('prefers the structured fields', () => {
    expect(
      parseOverride({
        code: 'force_approved',
        detail: 'by u: n',
        userId: 'user_9',
        note: 'comedy',
        at: '2026-09-27T10:00:00Z',
      }),
    ).toEqual({ userId: 'user_9', note: 'comedy', at: '2026-09-27T10:00:00.000Z' });
  });

  it('falls back to the legacy "by <user>: <note>" detail with no time', () => {
    expect(parseOverride({ detail: 'by user_1: quiet by design\nsecond line' })).toEqual({
      userId: 'user_1',
      note: 'quiet by design\nsecond line',
      at: null,
    });
    expect(parseOverride(undefined)).toEqual({ userId: null, note: null, at: null });
  });
});

describe('failedChecksOf', () => {
  it('keeps only failed checks', () => {
    expect(failedChecksOf([failed, passed])).toEqual([
      { code: 'loudness', severity: 'error', detail: '-24 LUFS' },
    ]);
  });
});

describe('listForceApprovals', () => {
  const override = (at: number | null) => ({
    code: 'force_approved',
    status: 'passed',
    severity: 'info',
    detail: 'by user_1: intentional',
    ...(at !== null && { userId: 'user_1', note: 'intentional', at: new Date(at).toISOString() }),
  });

  it('filters by approval time, newest first, with note, user, failed checks and project', async () => {
    const { db, calls } = fakeDb([
      row('recent', NOW - 40 * DAY, [failed, passed, override(NOW - DAY)]),
      row('legacy', NOW - 2 * DAY, [failed, override(null)]),
      row('old', NOW - 45 * DAY, [failed, override(NOW - 44 * DAY)]),
    ]);
    const res = await listForceApprovals(db, forceApprovalsQuery.parse({ days: '30' }), NOW);
    expect(res.items.map((i) => i.renderId)).toEqual(['recent', 'legacy']);
    expect(res.items[0]).toMatchObject({
      approvedByUserId: 'user_1',
      note: 'intentional',
      approvedAtRecorded: true,
      failedChecks: [{ code: 'loudness' }],
      project: { id: 'prj_recent', name: 'Launch' },
      organisationId: 'org_1',
    });
    expect(res.items[1]).toMatchObject({ approvedAtRecorded: false, note: 'intentional' });
    expect(res.truncated).toBe(false);
    expect(calls[0]).toMatchObject({
      where: { qualityCheckState: 'FORCE_APPROVED' },
      take: MAX_ROWS,
    });
  });

  it('scopes to one organisation and caps the page', async () => {
    const { db, calls } = fakeDb([
      row('a', NOW - DAY, [override(NOW - DAY)]),
      row('b', NOW - DAY, [override(NOW - 2 * DAY)]),
    ]);
    const res = await listForceApprovals(
      db,
      forceApprovalsQuery.parse({ organisationId: 'org_1', limit: '1' }),
      NOW,
    );
    expect(res.items.map((i) => i.renderId)).toEqual(['a']);
    expect(res.truncated).toBe(true);
    expect(calls[0]).toMatchObject({ where: { project: { organisationId: 'org_1' } } });
  });

  it('validates the query', () => {
    expect(forceApprovalsQuery.safeParse({ days: '0' }).success).toBe(false);
    expect(forceApprovalsQuery.safeParse({ days: '91' }).success).toBe(false);
    expect(forceApprovalsQuery.parse({}).days).toBe(30);
  });
});
