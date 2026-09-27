import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { CostCapPausedError } from '../../errors';
import type { Notifier } from '../notifications/notifier';
import { createCostGuard } from './guard';

// BACKLOG 13.19 — the cost guard applies an organisation's override before its plan tier's cap.

const NOW = Date.parse('2026-09-29T12:00:00Z');

function guardWith(
  spentToday: number,
  override: { dailyPence: number | null; monthlyPence: number | null } | null,
) {
  const db = {
    videoProject: { findUnique: vi.fn(async () => null) },
    providerUsage: {
      aggregate: vi.fn(async () => ({ _sum: { costPence: spentToday } })),
      findUnique: vi.fn(async () => null),
    },
    costAlert: { createManyAndReturn: vi.fn(async () => []) },
  };
  const notifier: Notifier = {
    notify: vi.fn(async () => ({ created: true })),
    notifyStaff: vi.fn(async () => 0),
  };
  return createCostGuard({
    db: db as never,
    caps: { orgDailyPenceByTier: { STANDARD: 3_000 }, orgMonthlyPenceByTier: { STANDARD: 15_000 } },
    notifier,
    audit: vi.fn(),
    logger: pino({ level: 'silent' }),
    metrics: { costAlerts: { inc: vi.fn() } } as never,
    now: () => NOW,
    overrides: vi.fn(async () => override),
  });
}

describe('cost guard with organisation overrides', () => {
  it('a raised daily cap lets an organisation spend past its tier cap', async () => {
    const guard = guardWith(5_000, { dailyPence: 20_000, monthlyPence: 100_000 });
    await expect(
      guard.assertNotPaused({ organisationId: 'org-1', planTier: 'STANDARD' }),
    ).resolves.toBeUndefined();
    const usage = await guard.usage({ organisationId: 'org-1', planTier: 'STANDARD' });
    expect(usage.find((u) => u.scope === 'ORG_DAILY')?.capPence).toBe(20_000);
    expect(usage.find((u) => u.scope === 'ORG_MONTHLY')?.capPence).toBe(100_000);
  });

  it('a lowered cap pauses earlier; a null column falls back to the tier', async () => {
    const guard = guardWith(1_000, { dailyPence: 500, monthlyPence: null });
    await expect(
      guard.assertNotPaused({ organisationId: 'org-1', planTier: 'STANDARD' }),
    ).rejects.toBeInstanceOf(CostCapPausedError);
    const usage = await guard.usage({ organisationId: 'org-1', planTier: 'STANDARD' });
    expect(usage.find((u) => u.scope === 'ORG_MONTHLY')?.capPence).toBe(15_000);
  });

  it('without an override the tier cap applies as before', async () => {
    const guard = guardWith(3_000, null);
    await expect(
      guard.assertNotPaused({ organisationId: 'org-1', planTier: 'STANDARD' }),
    ).rejects.toMatchObject({ scope: 'org_daily' });
  });
});
