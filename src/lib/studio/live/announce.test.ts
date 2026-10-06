import type { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { transitionProject } from '../pipeline/project-state';
import { announceProjectChange, getProjectEventBus, setProjectEventBus } from './announce';
import { createMemoryProjectEventBus, type ProjectChange } from './events';

type Db = Pick<PrismaClient, 'videoProject'>;

function fakeDb(organisationId: string | null, moved = 1) {
  return {
    videoProject: {
      findUnique: vi.fn(async () => (organisationId ? { organisationId } : null)),
      updateMany: vi.fn(async () => ({ count: moved })),
    },
  } as unknown as Db;
}

afterEach(() => setProjectEventBus(undefined));

describe('announceProjectChange', () => {
  it('does nothing without an installed bus', async () => {
    const db = fakeDb('org');
    await announceProjectChange(db, { projectId: 'p' });
    expect(getProjectEventBus()).toBeUndefined();
    expect(db.videoProject.findUnique).not.toHaveBeenCalled();
  });

  it("publishes on the project's organisation channel (looked up when not given)", async () => {
    const bus = createMemoryProjectEventBus();
    setProjectEventBus(bus);
    const seen: ProjectChange[] = [];
    await bus.subscribe('org_1', (c) => seen.push(c));
    await announceProjectChange(fakeDb('org_1'), { projectId: 'p1' });
    await announceProjectChange(fakeDb('ignored'), { projectId: 'p2', organisationId: 'org_1' });
    expect(seen).toEqual([{ projectId: 'p1' }, { projectId: 'p2' }]);
  });

  it('never throws (unknown project, failing bus)', async () => {
    setProjectEventBus({
      publish: async () => {
        throw new Error('down');
      },
      subscribe: async () => async () => undefined,
    });
    await expect(announceProjectChange(fakeDb(null), { projectId: 'p' })).resolves.toBeUndefined();
    await expect(announceProjectChange(fakeDb('org'), { projectId: 'p' })).resolves.toBeUndefined();
  });

  it('transitionProject announces a successful move only', async () => {
    const bus = createMemoryProjectEventBus();
    setProjectEventBus(bus);
    const seen: ProjectChange[] = [];
    await bus.subscribe('org', (c) => seen.push(c));
    const moved = await transitionProject(fakeDb('org', 1), {
      projectId: 'p1',
      runId: 'r',
      from: ['PLANNING'],
      to: 'ASSETS_QUEUED',
    });
    const stale = await transitionProject(fakeDb('org', 0), {
      projectId: 'p2',
      runId: 'r',
      from: ['PLANNING'],
      to: 'ASSETS_QUEUED',
    });
    expect([moved, stale]).toEqual([true, false]);
    await vi.waitFor(() => expect(seen).toEqual([{ projectId: 'p1' }]));
  });
});
