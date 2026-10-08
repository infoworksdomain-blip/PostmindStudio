import { describe, expect, it, vi } from 'vitest';
import type { Automation } from '@prisma/client';
import { listAutomations, nextPostTimes } from './automations';

// BACKLOG 25.9 — the Automations list's "Next post": the earliest post still to go out in each
// posting automation's current period, read in one query for the page.

const NOW = new Date('2026-10-07T12:00:00Z');

function automation(id: string, status: string, currentPlanId: string | null): Automation {
  return {
    id,
    organisationId: 'org',
    businessId: 'biz',
    createdByUserId: 'u',
    name: id,
    status,
    cadence: { mode: 'per_day', postsPerDay: 1 },
    duration: 'ongoing_weekly',
    platforms: ['tiktok'],
    targets: [],
    approvalMode: 'auto',
    timezone: 'Europe/London',
    language: 'en-GB',
    periodIndex: 1,
    currentPlanId,
    pauseReason: null,
    activatedAt: NOW,
    pausedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as Automation;
}

describe('nextPostTimes / listAutomations nextPostAt', () => {
  it('asks nothing without plans', async () => {
    const findMany = vi.fn();
    const db = { contentPlanItem: { findMany } } as unknown as Parameters<typeof nextPostTimes>[0];
    expect((await nextPostTimes(db, 'org', [], NOW)).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('gives posting automations their next post and the others none', async () => {
    const itemFind = vi
      .fn()
      .mockResolvedValue([{ planId: 'plan-a', slotAt: new Date('2026-10-08T09:00:00Z') }]);
    const db = {
      automation: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            automation('a', 'ACTIVE', 'plan-a'),
            automation('b', 'PAUSED', 'plan-b'),
            automation('c', 'GENERATING', 'plan-c'),
            automation('d', 'DRAFT', null),
          ]),
      },
      contentPlanItem: { findMany: itemFind },
    } as unknown as Parameters<typeof listAutomations>[0];
    const list = await listAutomations(db, 'org', {}, NOW);
    expect(list.map((a) => [a.id, a.nextPostAt])).toEqual([
      ['a', '2026-10-08T09:00:00.000Z'],
      ['b', null],
      ['c', null],
      ['d', null],
    ]);
    const where = itemFind.mock.calls[0]?.[0].where;
    expect(where).toMatchObject({
      organisationId: 'org',
      planId: { in: ['plan-a', 'plan-c'] },
      slotAt: { gte: NOW },
    });
    expect(itemFind.mock.calls[0]?.[0].distinct).toEqual(['planId']);
  });
});
