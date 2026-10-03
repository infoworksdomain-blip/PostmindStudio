import type { PrismaClient, VideoProject } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { JobQueue } from '../queue/enqueue';
import { VAGUE_BRIEF_REASON } from '../pipeline/vague-brief';
import { RESTRICTED_TOPICS_REASON } from '../pipeline/restricted-topics';
import {
  generateInput,
  generateProject,
  projectDirectionOptions,
  projectPendingRestrictedTopics,
} from './projects';

// BACKLOG 20.18 — generate accepts directionChosen and records it for the run; the project detail
// exposes the suggested directions only while the project waits for a choice.

describe('generateInput (20.18)', () => {
  it('accepts directionChosen with or without a new brief', () => {
    expect(generateInput.parse({ rawInput: 'Space facts', directionChosen: true })).toMatchObject({
      rawInput: 'Space facts',
      directionChosen: true,
    });
    expect(generateInput.parse({ directionChosen: false })).toMatchObject({
      directionChosen: false,
    });
    expect(generateInput.parse({}).directionChosen).toBeUndefined();
  });

  it('rejects a non-boolean directionChosen and an empty brief', () => {
    expect(generateInput.safeParse({ directionChosen: 'yes' }).success).toBe(false);
    expect(generateInput.safeParse({ rawInput: '   ', directionChosen: true }).success).toBe(false);
  });
});

describe('projectDirectionOptions (20.18)', () => {
  const base = {
    state: 'DRAFT' as const,
    errorReason: VAGUE_BRIEF_REASON,
    metadata: { directionOptions: ['A', ' B ', 'C', 'D'] },
  };

  it('returns the cleaned options while the project is DRAFT with brief_too_vague', () => {
    expect(projectDirectionOptions(base)).toEqual(['A', 'B', 'C']);
  });

  it('returns [] once the project has moved on or failed for another reason', () => {
    expect(projectDirectionOptions({ ...base, state: 'QUEUED' })).toEqual([]);
    expect(projectDirectionOptions({ ...base, errorReason: null })).toEqual([]);
    expect(
      projectDirectionOptions({ ...base, errorReason: 'restricted_topics: confirm (spec 13.3)' }),
    ).toEqual([]);
    expect(projectDirectionOptions({ ...base, metadata: null })).toEqual([]);
  });
});

describe('projectPendingRestrictedTopics (20.18, spec 13.3)', () => {
  const base = {
    state: 'DRAFT' as const,
    errorReason: RESTRICTED_TOPICS_REASON,
    metadata: { pendingRestrictedTopics: ['politics', ' politics ', 'alcohol'] },
  };

  it('returns the cleaned topics while the project waits for confirmation', () => {
    expect(projectPendingRestrictedTopics(base)).toEqual(['politics', 'alcohol']);
  });

  it('returns [] once the project has moved on or waits for something else', () => {
    expect(projectPendingRestrictedTopics({ ...base, state: 'QUEUED' })).toEqual([]);
    expect(projectPendingRestrictedTopics({ ...base, errorReason: VAGUE_BRIEF_REASON })).toEqual(
      [],
    );
    expect(projectPendingRestrictedTopics({ ...base, metadata: null })).toEqual([]);
  });
});

describe('generateProject metadata (20.18)', () => {
  function fakeDb(project: Partial<VideoProject>) {
    const updateMany = vi.fn(async (_args: { data: { metadata: Record<string, unknown> } }) => ({
      count: 1,
    }));
    const db = {
      videoProject: {
        findFirst: vi.fn(async () => ({
          id: 'p1',
          organisationId: 'o1',
          state: 'DRAFT',
          errorReason: VAGUE_BRIEF_REASON,
          updatedAt: new Date('2026-10-02T09:00:00Z'),
          metadata: { runId: 'old', directionOptions: ['A', 'B', 'C'], lastBriefVague: true },
          ...project,
        })),
        updateMany,
      },
    } as unknown as PrismaClient;
    const queue = { add: vi.fn(async () => undefined) } as unknown as JobQueue;
    return { db, queue, updateMany };
  }
  const tenant = { organisationId: 'o1', organisation: { id: 'o1', planTier: 'STANDARD' } };

  it('stores directionChosen for the run, clears the options and keeps lastBriefVague', async () => {
    const { db, queue, updateMany } = fakeDb({});
    await generateProject({ db, queue }, tenant, 'p1', {
      rawInput: 'Space facts',
      directionChosen: true,
    });
    const data = updateMany.mock.calls[0]?.[0].data as {
      description: string;
      metadata: Record<string, unknown>;
    };
    expect(data.description).toBe('Space facts');
    expect(data.metadata.directionChosen).toBe(true);
    expect(data.metadata.directionOptions).toBeUndefined();
    expect(data.metadata.lastBriefVague).toBe(true);
  });

  it('confirming restricted topics records the confirmation and clears the pending list', async () => {
    const { db, queue, updateMany } = fakeDb({
      errorReason: RESTRICTED_TOPICS_REASON,
      metadata: { runId: 'old', pendingRestrictedTopics: ['politics'] },
    });
    await generateProject({ db, queue }, tenant, 'p1', { confirmRestrictedTopics: true });
    const data = updateMany.mock.calls[0]?.[0].data as { metadata: Record<string, unknown> };
    expect(data.metadata.restrictedTopicsConfirmed).toBe(true);
    expect(data.metadata.pendingRestrictedTopics).toBeUndefined();
  });

  it('a plain generate does not carry an earlier run’s directionChosen over', async () => {
    const { db, queue, updateMany } = fakeDb({
      metadata: { runId: 'old', directionChosen: true },
    });
    await generateProject({ db, queue }, tenant, 'p1', {});
    const data = updateMany.mock.calls[0]?.[0].data as { metadata: Record<string, unknown> };
    expect(data.metadata.directionChosen).toBeUndefined();
  });

  it('puts the brief and the directions back when the queue is down', async () => {
    const metadata = { runId: 'old', directionOptions: ['A', 'B', 'C'], lastBriefVague: true };
    const { db, updateMany } = fakeDb({ description: 'space video', metadata });
    const queue = {
      add: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    } as unknown as JobQueue;
    await expect(
      generateProject({ db, queue }, tenant, 'p1', { rawInput: 'B', directionChosen: true }),
    ).rejects.toMatchObject({ name: 'UpstreamServiceError' });
    const restore = updateMany.mock.calls[1]?.[0].data as Record<string, unknown>;
    expect(restore).toMatchObject({
      state: 'DRAFT',
      errorReason: VAGUE_BRIEF_REASON,
      description: 'space video',
      metadata,
    });
  });
});
