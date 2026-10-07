import type { ImageSource, PrismaClient } from '@prisma/client';
import type { BusinessScope } from '../images/library';
import type { AssetStorage } from '../storage';
import {
  fetchImage,
  RELEVANCE_MAX_IMAGE_BYTES,
  type ImageLoader,
  type RelevanceDeps,
  type RelevanceGate,
} from './image-relevance';

// BACKLOG 25.x follow-up — library matches must fit the slide too. Production re-run 2026-10-07:
// the gym's "Coaches who know your name" got the SAME puppies photo after the 25.x fix, because
// the pre-fix run had stored that stock photo in the business's library and the library is
// searched (pgvector) before stock. Now, for each slide, up to LIBRARY_CHECK_CANDIDATES library
// hits above MIN_SIMILARITY are considered in similarity order:
//   - the business's own pictures (UPLOAD, SCRAPED from its website) are trusted: no check;
//   - auto-stored STOCK and GENERATED pictures must pass the same yes/no check as stock hits
//     (one batched call, the per-slideshow cap shared with stock; outage or cap → accepted).
// The first candidate that is own or passed is used; when none is, the slide falls through to
// stock and generation. A rejected picture is never deleted or marked (a different slide may
// want it, and nothing is recorded that could leak across organisations).

/** Library candidates judged per slide (one batched check). */
export const LIBRARY_CHECK_CANDIDATES = 3;

/** Pictures the business supplied itself: trusted without a check. */
export const OWN_IMAGE_SOURCES: ReadonlySet<ImageSource> = new Set<ImageSource>([
  'UPLOAD',
  'SCRAPED',
]);

export interface LibraryRelevanceDeps extends RelevanceDeps {
  db: PrismaClient;
  storage: AssetStorage;
}

interface LibraryRow {
  id: string;
  source: ImageSource;
  s3Bucket: string;
  s3Key: string;
  publicUrl: string | null;
}

/** The stored object's bytes (capped), or the hotlinked picture (Unsplash) downloaded. */
function loaderFor(deps: LibraryRelevanceDeps, row: LibraryRow): ImageLoader {
  return async () => {
    if (row.s3Bucket && row.s3Key) {
      const size = await deps.storage.size(row.s3Bucket, row.s3Key);
      if (size <= 0 || size > RELEVANCE_MAX_IMAGE_BYTES) return null;
      return deps.storage.readRange(row.s3Bucket, row.s3Key, 0, size - 1);
    }
    return row.publicUrl ? fetchImage(deps, row.publicUrl) : null;
  };
}

/**
 * The first of `ids` (similarity order) that is the business's own picture or passes the
 * relevance gate, or undefined when every candidate was rejected.
 */
export async function relevantLibraryImage(
  deps: LibraryRelevanceDeps,
  scope: BusinessScope,
  input: { query: string; ids: readonly string[]; gate: RelevanceGate },
): Promise<string | undefined> {
  const ids = input.ids.slice(0, LIBRARY_CHECK_CANDIDATES);
  if (ids.length === 0) return undefined;
  const rows = await deps.db.imageLibraryItem.findMany({
    where: {
      id: { in: [...ids] },
      organisationId: scope.organisationId,
      businessId: scope.businessId,
    },
    select: { id: true, source: true, s3Bucket: true, s3Key: true, publicUrl: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
  const first = ordered[0];
  if (!first) return undefined;
  if (OWN_IMAGE_SOURCES.has(first.source)) return first.id;
  const checkable = ordered.filter((r) => !OWN_IMAGE_SOURCES.has(r.source));
  const kept = new Set(
    (await input.gate.screen(input.query, checkable, (row) => loaderFor(deps, row), 'library')).map(
      (r) => r.id,
    ),
  );
  return ordered.find((r) => OWN_IMAGE_SOURCES.has(r.source) || kept.has(r.id))?.id;
}
