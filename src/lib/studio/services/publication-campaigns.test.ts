import { describe, expect, it, vi } from 'vitest';
import { campaignsForProjects } from './publication-campaigns';

// BACKLOG 25.9 — the calendar's campaign label and source filter: a post's month plan or
// automation, read for a whole page in two queries, scoped to the organisation.

function stubDb(
  items: Array<{
    projectId: string | null;
    plan: { id: string; startDate: string; days: number; automationId: string | null };
  }>,
  automations: Array<{ id: string; name: string }> = [],
) {
  const itemFind = vi.fn().mockResolvedValue(items);
  const automationFind = vi.fn().mockResolvedValue(automations);
  return {
    db: {
      contentPlanItem: { findMany: itemFind },
      automation: { findMany: automationFind },
    } as unknown as Parameters<typeof campaignsForProjects>[0],
    itemFind,
    automationFind,
  };
}

describe('campaignsForProjects', () => {
  it('asks nothing for an empty page', async () => {
    const { db, itemFind } = stubDb([]);
    expect((await campaignsForProjects(db, 'org', [])).size).toBe(0);
    expect(itemFind).not.toHaveBeenCalled();
  });

  it('labels month-plan and automation posts and leaves the rest out', async () => {
    const { db, itemFind, automationFind } = stubDb(
      [
        {
          projectId: 'p1',
          plan: { id: 'plan1', startDate: '2026-10-01', days: 30, automationId: null },
        },
        {
          projectId: 'p2',
          plan: { id: 'plan2', startDate: '2026-10-05', days: 7, automationId: 'auto1' },
        },
      ],
      [{ id: 'auto1', name: 'Weekly tips' }],
    );
    const map = await campaignsForProjects(db, 'org', ['p1', 'p2', 'p3', 'p1']);
    expect(map.get('p1')).toEqual({
      kind: 'plan',
      planId: 'plan1',
      startDate: '2026-10-01',
      days: 30,
    });
    expect(map.get('p2')).toEqual({
      kind: 'automation',
      planId: 'plan2',
      automationId: 'auto1',
      name: 'Weekly tips',
    });
    expect(map.has('p3')).toBe(false);
    // One query per table, scoped to the organisation, with de-duplicated ids.
    expect(itemFind).toHaveBeenCalledTimes(1);
    expect(itemFind.mock.calls[0]?.[0].where).toEqual({
      organisationId: 'org',
      projectId: { in: ['p1', 'p2', 'p3'] },
    });
    expect(automationFind.mock.calls[0]?.[0].where).toEqual({
      organisationId: 'org',
      id: { in: ['auto1'] },
    });
  });

  it('falls back to the plan when the automation is not in the organisation', async () => {
    const { db } = stubDb([
      {
        projectId: 'p1',
        plan: { id: 'plan1', startDate: '2026-10-01', days: 7, automationId: 'gone' },
      },
    ]);
    expect((await campaignsForProjects(db, 'org', ['p1'])).get('p1')).toMatchObject({
      kind: 'plan',
      planId: 'plan1',
    });
  });

  it('skips the automation query when no plan belongs to one', async () => {
    const { db, automationFind } = stubDb([
      {
        projectId: 'p1',
        plan: { id: 'plan1', startDate: '2026-10-01', days: 7, automationId: null },
      },
    ]);
    await campaignsForProjects(db, 'org', ['p1']);
    expect(automationFind).not.toHaveBeenCalled();
  });
});
