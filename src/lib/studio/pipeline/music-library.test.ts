import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../../../../test/helpers/memory-storage';
import { ConfigurationError } from '../../errors';
import {
  addToLibrary,
  DEFAULT_MUSIC_LIBRARY_SIZE,
  musicBucketSec,
  musicLibraryFromEnv,
  pickLibraryTrack,
} from './music-library';

// BACKLOG 23.1 — music library selection: buckets, settings, rotation, best-effort adds.

const KEY = 'a'.repeat(32);
const T0 = Date.parse('2026-10-06T12:00:00Z');

interface Row {
  id: string;
  promptKey: string;
  bucketSec: number;
  durationSec: number;
  s3Bucket: string;
  s3Key: string;
  source: string;
  lastUsedAt: Date | null;
  createdAt: Date;
  useCount: number;
}

function fakeDb(rows: Row[]) {
  const update = vi.fn(async (args: { where: { id: string }; data: { lastUsedAt: Date } }) => {
    const row = rows.find((r) => r.id === args.where.id);
    if (row) Object.assign(row, { lastUsedAt: args.data.lastUsedAt, useCount: row.useCount + 1 });
    return row;
  });
  const db = {
    musicLibraryTrack: {
      findMany: vi.fn(async (args: { where: { promptKey: string; bucketSec: number } }) =>
        rows
          .filter(
            (r) => r.promptKey === args.where.promptKey && r.bucketSec === args.where.bucketSec,
          )
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      ),
      update,
      create: vi.fn(
        async (args: { data: Omit<Row, 'id' | 'createdAt' | 'lastUsedAt' | 'useCount'> }) => {
          const row: Row = {
            ...args.data,
            id: `t${rows.length + 1}`,
            createdAt: new Date(T0),
            lastUsedAt: null,
            useCount: 0,
          };
          rows.push(row);
          return row;
        },
      ),
    },
  } as unknown as Pick<PrismaClient, 'musicLibraryTrack'>;
  return { db, update };
}

const track = (id: string, minutes: number, lastUsedMin: number | null): Row => ({
  id,
  promptKey: KEY,
  bucketSec: 30,
  durationSec: 30,
  s3Bucket: 'assets',
  s3Key: `music-library/${KEY}/${id}.mp3`,
  source: 'elevenlabs-music:music_v1',
  createdAt: new Date(T0 + minutes * 60_000),
  lastUsedAt: lastUsedMin === null ? null : new Date(T0 + lastUsedMin * 60_000),
  useCount: 0,
});

describe('music library settings and buckets (23.1)', () => {
  it('rounds a request up to its bucket, at most 300 s', () => {
    expect(musicBucketSec(3)).toBe(15);
    expect(musicBucketSec(15)).toBe(15);
    expect(musicBucketSec(15.2)).toBe(30);
    expect(musicBucketSec(45)).toBe(60);
    expect(musicBucketSec(299)).toBe(300);
    expect(musicBucketSec(600)).toBe(300);
  });

  it('is on with 5 tracks a key by default; off and size from env', () => {
    expect(musicLibraryFromEnv({})).toEqual({ enabled: true, size: DEFAULT_MUSIC_LIBRARY_SIZE });
    expect(musicLibraryFromEnv({ STUDIO_MUSIC_LIBRARY: 'off' }).enabled).toBe(false);
    expect(musicLibraryFromEnv({ STUDIO_MUSIC_LIBRARY_SIZE: '3' }).size).toBe(3);
    expect(() => musicLibraryFromEnv({ STUDIO_MUSIC_LIBRARY_SIZE: '0' })).toThrow(
      ConfigurationError,
    );
    expect(() => musicLibraryFromEnv({ STUDIO_MUSIC_LIBRARY_SIZE: 'x' })).toThrow(
      ConfigurationError,
    );
  });
});

describe('pickLibraryTrack (23.1)', () => {
  it('generates (null) while the key has fewer than N tracks', async () => {
    const { db, update } = fakeDb([track('t1', 0, null), track('t2', 1, null)]);
    expect(
      await pickLibraryTrack({ db, now: () => T0 }, { promptKey: KEY, bucketSec: 30, size: 3 }),
    ).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it('rotates: never-used tracks first (oldest first), then the least recently used', async () => {
    const rows = [track('t1', 0, 50), track('t2', 1, null), track('t3', 2, 10)];
    const { db } = fakeDb(rows);
    let now = T0 + 100 * 60_000;
    const pick = () =>
      pickLibraryTrack(
        { db, now: () => (now += 60_000) },
        { promptKey: KEY, bucketSec: 30, size: 3 },
      );
    expect((await pick())?.id).toBe('t2');
    expect((await pick())?.id).toBe('t3');
    expect((await pick())?.id).toBe('t1');
    expect((await pick())?.id).toBe('t2');
    expect(rows.find((r) => r.id === 't2')?.useCount).toBe(2);
  });

  it('only matches the same prompt key and bucket', async () => {
    const { db } = fakeDb([track('t1', 0, null)]);
    const deps = { db, now: () => T0 };
    expect(
      await pickLibraryTrack(deps, { promptKey: 'b'.repeat(32), bucketSec: 30, size: 1 }),
    ).toBeNull();
    expect(await pickLibraryTrack(deps, { promptKey: KEY, bucketSec: 60, size: 1 })).toBeNull();
    expect((await pickLibraryTrack(deps, { promptKey: KEY, bucketSec: 30, size: 1 }))?.id).toBe(
      't1',
    );
  });
});

describe('addToLibrary (23.1)', () => {
  const logger = { warn: vi.fn(), info: vi.fn() };

  it('copies the track out of the organisation prefix into music-library/', async () => {
    const { storage, objects } = memoryStorage();
    await storage.put({
      bucket: 'assets',
      key: 'orgs/o1/projects/p1/providers/elevenlabs-music/x.mp3',
      body: new Uint8Array([1, 2, 3]),
      contentType: 'audio/mpeg',
    });
    const rows: Row[] = [];
    const { db } = fakeDb(rows);
    const added = await addToLibrary(
      { db, storage, logger, bucket: 'assets' },
      {
        promptKey: KEY,
        bucketSec: 15,
        durationSec: 15,
        from: { bucket: 'assets', key: 'orgs/o1/projects/p1/providers/elevenlabs-music/x.mp3' },
        source: 'elevenlabs-music:music_v1',
        providerJobId: 'pj-1',
        costPence: 4,
      },
    );
    expect(added?.s3Key).toMatch(new RegExp(`^music-library/${KEY}/[0-9a-f-]+\\.mp3$`));
    expect(objects.get(`assets/${added?.s3Key}`)?.body).toEqual(new Uint8Array([1, 2, 3]));
    expect(rows[0]).toMatchObject({ promptKey: KEY, bucketSec: 15, costPence: 4 });
  });

  it('is best effort: a storage failure is logged and nothing is added', async () => {
    const { storage } = memoryStorage();
    const rows: Row[] = [];
    const { db } = fakeDb(rows);
    const added = await addToLibrary(
      { db, storage, logger, bucket: 'assets' },
      {
        promptKey: KEY,
        bucketSec: 15,
        durationSec: 15,
        from: { bucket: 'assets', key: 'missing.mp3' },
        source: 'elevenlabs-music',
        providerJobId: null,
        costPence: 0,
      },
    );
    expect(added).toBeNull();
    expect(rows).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });
});
