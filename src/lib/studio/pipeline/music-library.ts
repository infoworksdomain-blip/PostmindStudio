import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { ConfigurationError } from '../../errors';
import { MAX_MUSIC_SEC } from '../providers/elevenlabs-music';
import type { AssetStorage } from '../storage';

// BACKLOG 23.1 — music reuse (operator request 2026-10-06: ElevenLabs music p50 6.9 s and ~5p
// per video, generated fresh every time). Generated music beds go into a platform-wide library
// keyed by (prompt key, duration bucket):
//   - the prompt key is music-prompt.ts's hash of a prompt built only from closed vocabularies
//     (moods, genres, energy, tempo), so it carries no customer text and no language;
//   - the duration bucket is the request rounded UP to 15 / 30 / 60 / 120 / 180 / 300 s, and a
//     library track is generated at the bucket's full length, so it covers every video in the
//     bucket (the EDL trims it to the video and fades the last clip out, as for any track).
// A video takes an existing track only once the key has `size` tracks (default 5), rotating to
// the least recently used one so consecutive videos do not share a bed; with fewer, a new track
// is generated (and added). Only ElevenLabs Music generations made on the platform account are
// added (never a Storyblocks library pick, never a BYOC organisation's own account).
// Tracks are copied to music-library/<promptKey>/<id>.mp3 in the assets bucket: outside every
// organisation's prefix (account deletion purges orgs/<id>/) and outside the 30-day provider-
// output expiry (intermediates/ on R2, the provider-output tag on S3).
//
// STUDIO_MUSIC_LIBRARY=off turns reuse off (every video generates, as before 23.1);
// STUDIO_MUSIC_LIBRARY_SIZE (1–20, default 5) is the rotation size per key.

export const MUSIC_BUCKETS_SEC = [15, 30, 60, 120, 180, MAX_MUSIC_SEC] as const;
export const DEFAULT_MUSIC_LIBRARY_SIZE = 5;
const MAX_LIBRARY_SIZE = 20;
export const MUSIC_LIBRARY_PREFIX = 'music-library/';
/** Only generated music we own goes into the library. */
export const LIBRARY_SOURCE_PROVIDERS: ReadonlySet<string> = new Set(['elevenlabs-music']);
const PROMPT_KEY = /^[a-f0-9]{8,64}$/;

export interface MusicLibrarySettings {
  enabled: boolean;
  /** Tracks per (prompt key, bucket) before one is reused. */
  size: number;
}

export function musicLibraryFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): MusicLibrarySettings {
  const enabled = env.STUDIO_MUSIC_LIBRARY?.trim().toLowerCase() !== 'off';
  const raw = env.STUDIO_MUSIC_LIBRARY_SIZE?.trim();
  if (!raw) return { enabled, size: DEFAULT_MUSIC_LIBRARY_SIZE };
  const size = Number(raw);
  if (!/^\d+$/.test(raw) || size < 1 || size > MAX_LIBRARY_SIZE) {
    throw new ConfigurationError(`STUDIO_MUSIC_LIBRARY_SIZE must be 1–${MAX_LIBRARY_SIZE}`);
  }
  return { enabled, size };
}

/** The bucket for a requested length: the smallest bucket that covers it (300 s at most). */
export function musicBucketSec(requestSec: number): number {
  return MUSIC_BUCKETS_SEC.find((b) => b >= requestSec) ?? MAX_MUSIC_SEC;
}

export interface LibraryTrack {
  id: string;
  s3Bucket: string;
  s3Key: string;
  durationSec: number;
  source: string;
}

type LibraryDb = Pick<PrismaClient, 'musicLibraryTrack'>;

/**
 * The track to reuse for this key, or null to generate a new one (fewer than `size` tracks).
 * Rotation: the least recently used track (never used first, then oldest use), marked used.
 */
export async function pickLibraryTrack(
  deps: { db: LibraryDb; now: () => number },
  input: { promptKey: string; bucketSec: number; size: number },
): Promise<LibraryTrack | null> {
  const tracks = await deps.db.musicLibraryTrack.findMany({
    where: { promptKey: input.promptKey, bucketSec: input.bucketSec },
    orderBy: { createdAt: 'asc' },
  });
  if (tracks.length < input.size) return null;
  const pick = [...tracks].sort(
    (a, b) =>
      (a.lastUsedAt?.getTime() ?? 0) - (b.lastUsedAt?.getTime() ?? 0) ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  )[0];
  if (!pick) return null;
  await deps.db.musicLibraryTrack.update({
    where: { id: pick.id },
    data: { lastUsedAt: new Date(deps.now()), useCount: { increment: 1 } },
  });
  return {
    id: pick.id,
    s3Bucket: pick.s3Bucket,
    s3Key: pick.s3Key,
    durationSec: pick.durationSec,
    source: pick.source,
  };
}

/** Forget a track whose object is gone (the next video generates a replacement). */
export async function dropLibraryTrack(db: LibraryDb, id: string): Promise<void> {
  await db.musicLibraryTrack.deleteMany({ where: { id } });
}

/**
 * Copy a freshly generated track into the library. Best effort: a failure is logged and the
 * video keeps its own track (the next video for the key simply generates again).
 */
export async function addToLibrary(
  deps: {
    db: LibraryDb;
    storage: Pick<AssetStorage, 'size' | 'readRange' | 'put'>;
    logger: Pick<Logger, 'warn' | 'info'>;
    bucket: string;
  },
  input: {
    promptKey: string;
    bucketSec: number;
    durationSec: number;
    from: { bucket: string; key: string };
    source: string;
    providerJobId: string | null;
    costPence: number;
  },
): Promise<LibraryTrack | null> {
  if (!PROMPT_KEY.test(input.promptKey)) return null;
  try {
    const bytes = await deps.storage.size(input.from.bucket, input.from.key);
    if (bytes <= 0) return null;
    const body = await deps.storage.readRange(input.from.bucket, input.from.key, 0, bytes - 1);
    const stored = await deps.storage.put({
      bucket: deps.bucket,
      key: `${MUSIC_LIBRARY_PREFIX}${input.promptKey}/${randomUUID()}.mp3`,
      body,
      contentType: 'audio/mpeg',
    });
    const row = await deps.db.musicLibraryTrack.create({
      data: {
        promptKey: input.promptKey,
        bucketSec: input.bucketSec,
        durationSec: input.durationSec,
        s3Bucket: stored.bucket,
        s3Key: stored.key,
        source: input.source,
        providerJobId: input.providerJobId,
        costPence: input.costPence,
      },
    });
    deps.logger.info(
      { trackId: row.id, promptKey: input.promptKey, bucketSec: input.bucketSec },
      'music track added to the library',
    );
    return {
      id: row.id,
      s3Bucket: row.s3Bucket,
      s3Key: row.s3Key,
      durationSec: row.durationSec,
      source: row.source,
    };
  } catch (err) {
    deps.logger.warn({ err, promptKey: input.promptKey }, 'music library add failed; skipped');
    return null;
  }
}
