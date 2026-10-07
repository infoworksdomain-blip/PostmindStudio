import { describe, expect, it, vi } from 'vitest';
import { liveSnapshot, liveSnapshots, statusQuery, type SnapshotDeps } from './snapshot';

const NOW = Date.parse('2026-10-06T10:02:00Z');

interface Row {
  id: string;
  organisationId: string;
  state: string;
  sourceType: string;
  metadata: unknown;
}

function deps(rows: Row[], thumbnail: string | null = 'thumbs/p.jpg') {
  const findMany = vi.fn(
    async (args: { where: { id: { in: string[] }; organisationId: string } }) =>
      rows.filter(
        (r) => args.where.id.in.includes(r.id) && r.organisationId === args.where.organisationId,
      ),
  );
  const findFirst = vi.fn(async () =>
    thumbnail ? { s3Bucket: 'renders', thumbnailS3Key: thumbnail } : null,
  );
  const signedUrl = vi.fn(
    async (bucket: string, key: string) => `https://cdn.test/${bucket}/${key}`,
  );
  return {
    deps: {
      db: { videoProject: { findMany }, videoRender: { findFirst } },
      storage: { signedUrl },
      now: () => NOW,
    } as unknown as SnapshotDeps,
    findMany,
    signedUrl,
  };
}

const rows: Row[] = [
  {
    id: 'p_making',
    organisationId: 'org_a',
    state: 'ASSETS_GENERATING',
    sourceType: 'SLIDESHOW',
    metadata: { generationStart: { runId: 'r', at: '2026-10-06T10:00:00Z' } },
  },
  {
    id: 'p_ready',
    organisationId: 'org_a',
    state: 'READY_FOR_REVIEW',
    sourceType: 'CAROUSEL',
    metadata: {},
  },
  { id: 'p_b', organisationId: 'org_b', state: 'RENDERING', sourceType: 'BRIEF', metadata: {} },
];

describe('liveSnapshots', () => {
  it("returns only the caller organisation's projects (cross-org ids are absent)", async () => {
    const { deps: d, findMany } = deps(rows);
    const events = await liveSnapshots(d, 'org_a', ['p_making', 'p_b']);
    expect(events.map((e) => e.projectId)).toEqual(['p_making']);
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { organisationId: 'org_a', deletedAt: null },
    });
  });

  it('computes stage, progress and ETA from the run start', async () => {
    const { deps: d, signedUrl } = deps(rows);
    const event = await liveSnapshot(d, 'org_a', 'p_making');
    expect(event).toMatchObject({
      state: 'ASSETS_GENERATING',
      stage: 'making_clips',
      format: 'slideshow',
      startedAt: '2026-10-06T10:00:00Z',
      etaSec: 0,
      thumbnailUrl: null,
      at: new Date(NOW).toISOString(),
    });
    expect(event?.progressPct).toBe(80);
    expect(signedUrl).not.toHaveBeenCalled();
  });

  it('signs the latest thumbnail once the post is made', async () => {
    const { deps: d } = deps(rows);
    const event = await liveSnapshot(d, 'org_a', 'p_ready');
    expect(event).toMatchObject({
      stage: 'ready',
      thumbnailUrl: 'https://cdn.test/renders/thumbs/p.jpg',
    });
  });

  it('is null for a project of another organisation, and empty for no ids', async () => {
    const { deps: d, findMany } = deps(rows, null);
    expect(await liveSnapshot(d, 'org_a', 'p_b')).toBeNull();
    expect(await liveSnapshots(d, 'org_a', [])).toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});

describe('statusQuery', () => {
  it('splits, trims and de-duplicates ids, at most 100', () => {
    expect(statusQuery.parse({ ids: 'a, b,a,,' }).ids).toEqual(['a', 'b']);
    const many = Array.from({ length: 101 }, (_, i) => `p${i}`).join(',');
    expect(statusQuery.safeParse({ ids: many }).success).toBe(false);
    expect(statusQuery.safeParse({}).success).toBe(false);
  });
});
