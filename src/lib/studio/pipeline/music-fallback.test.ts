import { describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../../../../test/helpers/memory-storage';
import {
  CostCapPausedError,
  KillSwitchTriggeredError,
  NoProviderAvailableError,
  ProviderError,
  ProvidersUnavailableError,
  RateDeferredError,
} from '../../errors';
import type { PipelineDeps } from './deps';
import { fallbackLibraryTrack, musicFailureHandling } from './music-fallback';
import { pickFallbackTrack } from './music-library';
import { buildMusicPrompt } from './music-prompt';

// 25.x — music never silent under provider limits: the fallback decision and the library pick.

const T0 = Date.parse('2026-10-07T12:00:00Z');
const KEY = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

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

const row = (
  id: string,
  over: Partial<Row> & Pick<Row, 'promptKey' | 'durationSec'>,
  minutes = 0,
): Row => ({
  id,
  bucketSec: over.durationSec,
  s3Bucket: 'assets',
  s3Key: `music-library/${over.promptKey}/${id}.mp3`,
  source: 'elevenlabs-music:music_v2_5',
  lastUsedAt: null,
  createdAt: new Date(T0 + minutes * 60_000),
  useCount: 0,
  ...over,
});

type Where = {
  promptKey?: string;
  durationSec?: { gte?: number; gt?: number };
  id?: { notIn: string[] };
};
type Order = Array<Record<string, 'asc' | 'desc' | { sort: 'asc' | 'desc'; nulls: string }>>;

const value = (r: Row, field: string): number => {
  const v = r[field as keyof Row];
  if (v instanceof Date) return v.getTime();
  return v === null ? -Infinity : Number(v);
};

/** Enough of Prisma's findFirst for pickFallbackTrack (where + orderBy over library rows). */
function fakeDb(rows: Row[]) {
  const assets: Array<Record<string, unknown>> = [];
  const db = {
    musicLibraryTrack: {
      findFirst: vi.fn(async (args: { where: Where; orderBy: Order }) => {
        const { where } = args;
        const hits = rows.filter(
          (r) =>
            (where.promptKey === undefined || r.promptKey === where.promptKey) &&
            (where.durationSec?.gte === undefined || r.durationSec >= where.durationSec.gte) &&
            (where.durationSec?.gt === undefined || r.durationSec > where.durationSec.gt) &&
            !where.id?.notIn.includes(r.id),
        );
        const sorted = [...hits].sort((a, b) => {
          for (const order of args.orderBy) {
            const [field, dir] = Object.entries(order)[0] ?? ['id', 'asc'];
            const sort = typeof dir === 'string' ? dir : dir.sort;
            const diff = value(a, field) - value(b, field);
            if (diff !== 0) return sort === 'asc' ? diff : -diff;
          }
          return 0;
        });
        return sorted[0] ?? null;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: { lastUsedAt: Date } }) => {
        const hit = rows.find((r) => r.id === args.where.id);
        if (hit)
          Object.assign(hit, { lastUsedAt: args.data.lastUsedAt, useCount: hit.useCount + 1 });
        return hit;
      }),
      deleteMany: vi.fn(async (args: { where: { id: string } }) => {
        const i = rows.findIndex((r) => r.id === args.where.id);
        if (i >= 0) rows.splice(i, 1);
        return { count: i >= 0 ? 1 : 0 };
      }),
    },
    videoAsset: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const asset = { ...args.data, id: `asset-${assets.length + 1}` };
        assets.push(asset);
        return { id: asset.id };
      }),
    },
  };
  return { db: db as unknown as PipelineDeps['db'], assets };
}

describe('musicFailureHandling (25.x)', () => {
  it('falls back for provider limits, outages, timeouts, credits and no routable provider', () => {
    for (const err of [
      new ProviderError('elevenlabs-music', 'rate_limited', 'too_many_concurrent_requests', true),
      new ProviderError('elevenlabs-music', 'provider_unavailable', '503', true),
      new ProviderError('elevenlabs-music', 'timeout', 'No result after 300s', true),
      new ProviderError('elevenlabs-music', 'insufficient_credits', 'quota_exceeded', false),
      new NoProviderAvailableError('No provider available for music'),
      new ProvidersUnavailableError('music', [
        { providerId: 'elevenlabs-music', errorClass: 'insufficient_credits' },
      ]),
      new Error('socket hang up'),
    ]) {
      expect(musicFailureHandling(err)).toBe('fallback');
    }
  });

  it('rethrows a full Studio-side slot (wait), a paused budget and the kill switch', () => {
    expect(
      musicFailureHandling(
        new RateDeferredError('elevenlabs-music', 10_000, { reason: 'provider_full' }),
      ),
    ).toBe('rethrow');
    expect(musicFailureHandling(new CostCapPausedError('project', 'paused'))).toBe('rethrow');
    expect(musicFailureHandling(new KillSwitchTriggeredError('global', 'killed'))).toBe('rethrow');
  });
});

describe('pickFallbackTrack (25.x)', () => {
  const pick = (rows: Row[], input: Parameters<typeof pickFallbackTrack>[1]) =>
    pickFallbackTrack({ db: fakeDb(rows).db, now: () => T0 }, input);

  it('prefers the prompt key, long enough, closest bucket, least recently used', async () => {
    const rows = [
      row('other-30', { promptKey: OTHER, durationSec: 30 }),
      row('key-60', { promptKey: KEY, durationSec: 60 }),
      row('key-30-used', { promptKey: KEY, durationSec: 30, lastUsedAt: new Date(T0) }, 1),
      row('key-30-fresh', { promptKey: KEY, durationSec: 30 }, 2),
      row('key-15', { promptKey: KEY, durationSec: 15 }),
    ];
    const got = await pick(rows, { promptKey: KEY, minSec: 20 });
    expect(got).toMatchObject({ id: 'key-30-fresh', match: 'prompt' });
    expect(rows.find((r) => r.id === 'key-30-fresh')?.useCount).toBe(1);
  });

  it('relaxes to any key long enough, then to the longest track (looped)', async () => {
    const rows = [
      row('key-15', { promptKey: KEY, durationSec: 15 }),
      row('other-60', { promptKey: OTHER, durationSec: 60 }),
    ];
    expect(await pick(rows, { promptKey: KEY, minSec: 30 })).toMatchObject({
      id: 'other-60',
      match: 'any',
    });
    expect(await pick(rows, { promptKey: KEY, minSec: 120 })).toMatchObject({
      id: 'other-60',
      match: 'loop',
    });
    expect(await pick(rows, { minSec: 10 })).toMatchObject({ match: 'any' });
  });

  it('returns null for an empty library and skips excluded tracks', async () => {
    expect(await pick([], { promptKey: KEY, minSec: 15 })).toBeNull();
    const rows = [row('only', { promptKey: KEY, durationSec: 15 })];
    expect(await pick(rows, { promptKey: KEY, minSec: 15, excludeIds: ['only'] })).toBeNull();
  });
});

describe('fallbackLibraryTrack (25.x)', () => {
  const built = buildMusicPrompt({
    briefTone: 'warm',
    brandToneKeywords: [],
    slideshowMusicMood: null,
    reference: null,
    format: 'short',
  });
  const project = { id: 'p1', organisationId: 'o1' };
  const logger = { warn: vi.fn(), info: vi.fn() } as unknown as PipelineDeps['logger'];

  async function setup(rows: Row[], stored: readonly string[]) {
    const { storage } = memoryStorage();
    for (const r of rows.filter((x) => stored.includes(x.id)))
      await storage.put({
        bucket: r.s3Bucket,
        key: r.s3Key,
        body: new Uint8Array([0x49, 0x44, 0x33]),
        contentType: 'audio/mpeg',
      });
    const { db, assets } = fakeDb(rows);
    return { deps: { db, storage, logger, now: () => T0 }, assets };
  }

  it('lays a same-key track under the video at no cost, filed under the prompt key', async () => {
    const rows = [row('t1', { promptKey: built.key, durationSec: 15 })];
    const { deps, assets } = await setup(rows, ['t1']);
    const got = await fallbackLibraryTrack(deps, {
      project,
      built,
      requestSec: 15,
      reason: 'elevenlabs-music rate_limited: too_many_concurrent_requests',
    });
    expect(got).toMatchObject({
      assetId: 'asset-1',
      libraryTrackId: 't1',
      match: 'prompt',
      stored: { bucket: 'assets', key: rows[0]?.s3Key, durationSec: 15 },
    });
    expect(assets[0]).toMatchObject({
      kind: 'AUDIO_MUSIC',
      source: 'music-library:t1',
      costPence: 0,
      providerJobId: null,
      fingerprint: built.key,
      metadata: expect.objectContaining({ fallbackFrom: expect.stringContaining('rate_limited') }),
    });
  });

  it('a track picked for another key is not filed under this prompt key', async () => {
    const rows = [row('t1', { promptKey: OTHER, durationSec: 30 })];
    const { deps, assets } = await setup(rows, ['t1']);
    const got = await fallbackLibraryTrack(deps, { project, built, requestSec: 15, reason: 'x' });
    expect(got?.match).toBe('any');
    expect(assets[0]?.fingerprint).toBeNull();
  });

  it('drops tracks whose object is gone and tries the next one', async () => {
    const rows = [
      row('gone', { promptKey: built.key, durationSec: 15 }),
      row('there', { promptKey: built.key, durationSec: 15 }, 1),
    ];
    const { deps } = await setup(rows, ['there']);
    const got = await fallbackLibraryTrack(deps, { project, built, requestSec: 15, reason: 'x' });
    expect(got?.libraryTrackId).toBe('there');
    expect(rows.map((r) => r.id)).toEqual(['there']);
  });

  it('null when the library has nothing usable; never throws', async () => {
    const empty = await setup([], []);
    expect(
      await fallbackLibraryTrack(empty.deps, { project, built, requestSec: 15, reason: 'x' }),
    ).toBeNull();
    const broken = await setup([], []);
    broken.deps.db.musicLibraryTrack.findFirst = vi.fn(async () => {
      throw new Error('db down');
    }) as unknown as typeof broken.deps.db.musicLibraryTrack.findFirst;
    expect(
      await fallbackLibraryTrack(broken.deps, { project, built, requestSec: 15, reason: 'x' }),
    ).toBeNull();
  });
});
