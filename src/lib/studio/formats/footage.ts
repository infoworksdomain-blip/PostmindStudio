import type { PrismaClient } from '@prisma/client';

// BACKLOG 22.1 / 22.2 — reference-library videos used AS FOOTAGE (a hook + demo video's reaction
// clip when no AI creator provider is available; a wall-of-text background). The library is a
// reference corpus: its licences allow TEMPLATE and INSPIRE (the video guides a new one), which is
// not permission to put the clip itself into a customer's published video. So a library video is
// used as footage only when its licence lists the FOOTAGE mode (video_library_licenses.allowedModes,
// a string array — no schema change), the licence has not expired and the item is not retired.
// Nothing is FOOTAGE-licensed until the operator marks it so (Studio decision 2026-10-05; no meme,
// celebrity or scraped clip is ever reused).

export const FOOTAGE_MODE = 'FOOTAGE';
/** Licence scenarios that can carry a FOOTAGE grant (never SCRAPED content). */
const FOOTAGE_SCENARIOS = ['LICENSED', 'OWNED', 'NOT_REQUIRED'] as const;

export interface FootageClip {
  libraryItemId: string;
  s3Bucket: string;
  s3Key: string;
  durationSec: number;
  aspectRatio: string;
}

/**
 * The best FOOTAGE-licensed library video whose category slug contains one of `categories` (or
 * whose tags contain one), at least `minSec` long. Portrait clips first for portrait videos.
 * Deterministic for a seed (the project id), so a re-run picks the same clip.
 */
export async function findFootageClip(
  db: Pick<PrismaClient, 'videoLibraryItem'>,
  input: {
    categories: readonly string[];
    minSec: number;
    aspectRatio: string;
    seed: string;
    now: Date;
  },
): Promise<FootageClip | null> {
  if (input.categories.length === 0) return null;
  const rows = await db.videoLibraryItem.findMany({
    where: {
      retiredAt: null,
      durationSec: { gte: input.minSec },
      license: {
        allowedModes: { has: FOOTAGE_MODE },
        scenario: { in: [...FOOTAGE_SCENARIOS] },
        OR: [{ licenseExpires: null }, { licenseExpires: { gt: input.now } }],
      },
      OR: [
        ...input.categories.map((c) => ({ category: { slug: { contains: c } } })),
        { tags: { hasSome: [...input.categories] } },
      ],
    },
    select: { id: true, s3Bucket: true, s3Key: true, durationSec: true, aspectRatio: true },
    orderBy: { id: 'asc' },
    take: 50,
  });
  if (rows.length === 0) return null;
  const matching = rows.filter((r) => r.aspectRatio === input.aspectRatio);
  const pool = matching.length ? matching : rows;
  const pick = pool[hashIndex(input.seed, pool.length)];
  if (!pick) return null;
  return {
    libraryItemId: pick.id,
    s3Bucket: pick.s3Bucket,
    s3Key: pick.s3Key,
    durationSec: pick.durationSec,
    aspectRatio: pick.aspectRatio,
  };
}

/** A stable index in [0, size) from a string (FNV-1a). */
export function hashIndex(seed: string, size: number): number {
  if (size <= 1) return 0;
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % size;
}

/** Category slug fragments for reaction / hook clips (hook + demo fallback). */
export const HOOK_LIBRARY_CATEGORIES = ['reaction', 'hook'] as const;
