import type { PrismaClient } from '@prisma/client';
import { ProviderError, ValidationError } from '../../errors';
import { vectorLiteral } from '../images/ingest';
import type { ProviderRunDeps } from '../pipeline/provider-run';
import { runProvider } from '../pipeline/provider-run';
import type { PlanTier } from '../providers/router';
import { vectorSql } from '../vector-sql';

// BACKLOG 13.8 — free-text library search (POST /library/search). The query is embedded with the
// same embedding path the corpus uses (runProvider → 'embedding', 1536 dims, A7.4), ranked by
// pgvector cosine similarity, plus a small keyword boost when query words appear in the title or
// the tags (so an exact "sourdough" title beats a merely similar one). Retired and unlicensed
// items never appear (A7.4: rows without a licence are rejected from search results).

export const EMBEDDING_DIMENSIONS = 1536;
/** Boost when any query word appears in the title. */
export const TITLE_BOOST = 0.1;
/** Boost per query word that is one of the item's tags, capped at TAG_BOOST_CAP. */
export const TAG_BOOST = 0.05;
export const TAG_BOOST_CAP = 0.15;
/** Offset cursors stop here: search is for finding a reference, not for paging the corpus. */
export const MAX_SEARCH_OFFSET = 480;
const MAX_TERMS = 10;

export interface SearchHit {
  id: string;
  /** Cosine similarity of the query and the item (0–1). */
  similarity: number;
  /** similarity + keyword boost: the ranking key. */
  score: number;
}

export interface SearchPage {
  hits: SearchHit[];
  nextCursor: string | null;
}

/** Lower-case query words (≥ 2 letters/digits), deduplicated, at most MAX_TERMS. */
export function queryTerms(q: string): string[] {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return [...new Set(words)].slice(0, MAX_TERMS);
}

/** ILIKE patterns for the terms, with LIKE wildcards escaped. */
export function likePatterns(terms: string[]): string[] {
  return terms.map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
}

/** Cursor = the offset of the next page, as a decimal string. */
export function parseCursor(cursor: string | null | undefined): number {
  if (cursor === null || cursor === undefined || cursor === '') return 0;
  if (!/^\d{1,4}$/.test(cursor)) throw new ValidationError('cursor is not valid');
  const offset = Number(cursor);
  if (offset > MAX_SEARCH_OFFSET) throw new ValidationError('cursor is past the last page');
  return offset;
}

const round = (n: number) => Number(n.toFixed(4));

async function embedQuery(
  providers: ProviderRunDeps,
  scope: { organisationId: string; planTier: PlanTier },
  q: string,
): Promise<number[]> {
  const run = await runProvider(
    {
      need: { kind: 'capability', capability: 'embedding' },
      planTier: scope.planTier,
      request: {
        capability: 'embedding',
        organisationId: scope.organisationId,
        input: [q],
        dimensions: EMBEDDING_DIMENSIONS,
      },
    },
    providers,
  );
  const vector = (run.output.metadata as { embeddings?: number[][] }).embeddings?.[0];
  if (!vector || vector.length !== EMBEDDING_DIMENSIONS)
    throw new ProviderError('embedding', 'unknown', 'Embedding had the wrong shape', true);
  return vector;
}

export async function searchLibrary(
  deps: { db: PrismaClient; providers: ProviderRunDeps },
  scope: { organisationId: string; planTier: PlanTier },
  input: { q: string; categorySlug?: string; limit: number; cursor?: string | null },
): Promise<SearchPage> {
  const offset = parseCursor(input.cursor);
  const terms = queryTerms(input.q);
  const vector = await embedQuery(deps.providers, scope, input.q);
  const literal = vectorLiteral(vector);
  const v = await vectorSql(deps.db);
  const prefix = input.categorySlug ? `${input.categorySlug.replace(/[%_\\]/g, '')}%` : '%';
  const patterns = likePatterns(terms);
  // With no usable words the boost is 0; ANY('{}') is false and the tag intersection is empty.
  const rows = await deps.db.$queryRaw<Array<{ id: string; distance: number; boost: number }>>`
    SELECT ranked.id, ranked.distance, ranked.boost FROM (
      SELECT l.id,
        (e.embedding ${v.distance} ${literal}${v.cast})::float8 AS distance,
        ((CASE WHEN l.title ILIKE ANY(${patterns}::text[]) THEN ${TITLE_BOOST} ELSE 0 END)
          + LEAST(${TAG_BOOST_CAP}, ${TAG_BOOST} * cardinality(ARRAY(
              SELECT unnest(l.tags) INTERSECT SELECT unnest(${terms}::text[])))))::float8 AS boost
      FROM studio.video_library_embeddings e
      JOIN studio.video_library l ON l.id = e."libraryItemId"
      JOIN studio.video_library_categories c ON c.id = l."categoryId"
      JOIN studio.video_library_licenses lic ON lic."libraryItemId" = l.id
      WHERE l."retiredAt" IS NULL AND c.slug LIKE ${prefix}
    ) ranked
    ORDER BY (1 - ranked.distance + ranked.boost) DESC, ranked.id ASC
    LIMIT ${input.limit + 1} OFFSET ${offset}`;
  const page = rows.slice(0, input.limit);
  const next = offset + input.limit;
  return {
    hits: page.map((r) => {
      const similarity = round(1 - Number(r.distance));
      return { id: r.id, similarity, score: round(similarity + Number(r.boost)) };
    }),
    nextCursor: rows.length > input.limit && next <= MAX_SEARCH_OFFSET ? String(next) : null,
  };
}
