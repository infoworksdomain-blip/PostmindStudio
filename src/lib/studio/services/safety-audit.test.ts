import type { SafetyAuditItem } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ConfigurationError, ConflictError, NotFoundError, ValidationError } from '../../errors';
import { failureRate } from './beta-dashboard';
import { feedbackInput } from './feedback';
import {
  auditResultInput,
  periodRange,
  previousPeriod,
  recordAuditResult,
  SAFETY_AUDIT_SAMPLE_DEFAULT,
  safetyAuditSampleFromEnv,
} from './safety-audit';

// BACKLOG 14.11 — pure parts of the Trust & Safety audit, feedback and beta dashboard services
// (test/api/beta-programme.test.ts covers them end to end on a real database).

describe('audit periods', () => {
  it('previousPeriod is the UTC month before now, across a year boundary', () => {
    expect(previousPeriod(Date.UTC(2026, 9, 1, 6))).toBe('2026-09');
    expect(previousPeriod(Date.UTC(2027, 0, 1, 0, 0, 1))).toBe('2026-12');
  });

  it('periodRange is [first of month, first of next month) and refuses bad input', () => {
    expect(periodRange('2026-12')).toEqual({
      start: new Date('2026-12-01T00:00:00Z'),
      end: new Date('2027-01-01T00:00:00Z'),
    });
    expect(() => periodRange('2026-13')).toThrow(ValidationError);
    expect(() => periodRange("2026-01'; --")).toThrow(ValidationError);
  });
});

describe('safetyAuditSampleFromEnv', () => {
  it('defaults to 50 and accepts 1–500', () => {
    expect(safetyAuditSampleFromEnv({})).toBe(SAFETY_AUDIT_SAMPLE_DEFAULT);
    expect(safetyAuditSampleFromEnv({ STUDIO_SAFETY_AUDIT_SAMPLE: ' 120 ' })).toBe(120);
  });

  it('refuses anything else', () => {
    for (const v of ['0', '501', '2.5', 'fifty'])
      expect(() => safetyAuditSampleFromEnv({ STUDIO_SAFETY_AUDIT_SAMPLE: v })).toThrow(
        ConfigurationError,
      );
  });
});

describe('auditResultInput', () => {
  it('needs a note for a miss, not for a pass', () => {
    expect(auditResultInput.safeParse({ result: 'pass' }).success).toBe(true);
    expect(auditResultInput.safeParse({ result: 'miss' }).success).toBe(false);
    expect(auditResultInput.safeParse({ result: 'miss', note: 'ok' }).success).toBe(false);
    expect(auditResultInput.safeParse({ result: 'miss', note: 'nudity' }).success).toBe(true);
    expect(auditResultInput.safeParse({ result: 'pending' }).success).toBe(false);
  });
});

describe('recordAuditResult', () => {
  const item = (over: Partial<SafetyAuditItem> = {}): SafetyAuditItem => ({
    id: 'a1',
    period: '2026-09',
    organisationId: 'org-1',
    publicationId: 'pub-1',
    projectId: 'p1',
    platform: 'tiktok',
    platformUrl: null,
    publishedAt: new Date('2026-09-10T00:00:00Z'),
    result: 'miss',
    note: 'weapon',
    reviewedByUserId: 'staff-1',
    reviewedAt: new Date(),
    createdAt: new Date(),
    ...over,
  });

  function deps(count: number, row: SafetyAuditItem | null, notifyStaff = vi.fn(async () => 1)) {
    return {
      db: {
        safetyAuditItem: {
          updateMany: vi.fn(async () => ({ count })),
          findUnique: vi.fn(async () => row),
        },
      } as never,
      notifier: { notify: vi.fn(), notifyStaff },
      logger: { error: vi.fn() },
      now: () => Date.now(),
    };
  }

  it('keeps a recorded miss when the staff notification fails (logged)', async () => {
    const d = deps(
      1,
      item(),
      vi.fn(async () => {
        throw new Error('db');
      }),
    );
    const result = await recordAuditResult(d, 'a1', { result: 'miss', note: 'weapon' }, 's');
    expect(result.result).toBe('miss');
    expect(d.logger.error).toHaveBeenCalledOnce();
  });

  it('does not notify on a pass; 404 unknown; 409 already recorded', async () => {
    const pass = deps(1, item({ result: 'pass', note: null }));
    await recordAuditResult(pass, 'a1', { result: 'pass' }, 's');
    expect(pass.notifier.notifyStaff).not.toHaveBeenCalled();
    await expect(
      recordAuditResult(deps(0, null), 'x', { result: 'pass' }, 's'),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      recordAuditResult(deps(0, item()), 'a1', { result: 'pass' }, 's'),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('feedbackInput / failureRate', () => {
  it('bounds the message at 2000 characters and needs an app path', () => {
    const ok = { kind: 'idea', message: 'x'.repeat(2000), screen: '/new?step=2' };
    expect(feedbackInput.safeParse(ok).success).toBe(true);
    expect(feedbackInput.safeParse({ ...ok, message: 'x'.repeat(2001) }).success).toBe(false);
    expect(feedbackInput.safeParse({ ...ok, screen: 'javascript:alert(1)' }).success).toBe(false);
    expect(feedbackInput.safeParse({ ...ok, message: '   ' }).success).toBe(false);
  });

  it('failureRate is failed / finished, null when nothing finished', () => {
    expect(failureRate(0, 0)).toBeNull();
    expect(failureRate(3, 1)).toBe(0.25);
    expect(failureRate(0, 2)).toBe(1);
  });
});
