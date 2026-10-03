import type { PrismaClient } from '@prisma/client';
import { ProviderError, ValidationError } from '../../errors';
import { vectorLiteral } from '../images/ingest';
import type { ProviderRunDeps } from '../pipeline/provider-run';
import { runProvider } from '../pipeline/provider-run';
import { EMBEDDING_MODEL, PROVIDER_ID as OPENAI_PROVIDER_ID } from '../providers/openai';
import type { PlanTier } from '../providers/router';
import { vectorSql } from '../vector-sql';
import { categoryLikeParams } from './category-filter';
import { MIN_SIMILARITY } from './relevance';
import { createUncachedLibraryCache, type LibraryCache } from './cache';

// BACKLOG 13.8 — free-text library search (POST /library/search). The query is embedded with the
// same embedding path the corpus uses (runProvider → 'embedding', 1536 dims, A7.4), ranked by
// pgvector cosine similarity, plus a small keyword boost when query words appear in the title or
// the tags (so an exact "sourdough" title beats a merely similar one). Retired and unlicensed
// items never appear (A7.4: rows without a licence are rejected from search results).

export const EMBEDDING_DIMENSIONS = 1536;
/**
 * 20.15: the query-embedding cache key's model part. Only OpenAI's vectors are cached (the
 * corpus is embedded with the same model); another provider's answer is used but not shared.
 */
export const QUERY_EMBEDDING_MODEL = `${OPENAI_PROVIDER_ID}:${EMBEDDING_MODEL}:${EMBEDDING_DIMENSIONS}`;
export { MIN_SIMILARITY };
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

/** The browse filters a search honours as well (same meaning as GET /library/videos). */
export interface SearchFilters {
  durationMin?: number;
  durationMax?: number;
  mood?: string;
  /** Lower-case tags the item must all carry. */
  tags?: string[];
}

/** Bind values for the filters: null / empty means "no constraint". */
export function filterParams(filters: SearchFilters): {
  durationMin: number | null;
  durationMax: number | null;
  mood: string | null;
  tags: string[];
} {
  const mood = filters.mood?.trim();
  return {
    durationMin: filters.durationMin ?? null,
    durationMax: filters.durationMax ?? null,
    mood: mood ? (likePatterns([mood])[0] ?? null) : null,
    tags: filters.tags ?? [],
  };
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
): Promise<{ vector: number[]; cacheable: boolean }> {
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
  return { vector, cacheable: run.decision.providerId === OPENAI_PROVIDER_ID };
}

const UNCACHED = createUncachedLibraryCache();

export async function searchLibrary(
  deps: { db: PrismaClient; providers: ProviderRunDeps; cache?: LibraryCache },
  scope: { organisationId: string; planTier: PlanTier },
  input: {
    q: string;
    categorySlug?: string;
    limit: number;
    cursor?: string | null;
  } & SearchFilters,
): Promise<SearchPage> {
  const offset = parseCursor(input.cursor);
  const terms = queryTerms(input.q);
  // 20.15: a query already embedded (by anyone, in the last 30 days) costs no provider call.
  const vector = await (deps.cache ?? UNCACHED).embedding(QUERY_EMBEDDING_MODEL, input.q, () =>
    embedQuery(deps.providers, scope, input.q),
  );
  const literal = vectorLiteral(vector);
  const v = await vectorSql(deps.db);
  const category = categoryLikeParams(input.categorySlug);
  const filter = filterParams(input);
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
      LEFT JOIN studio.video_library_analysis a ON a."libraryItemId" = l.id
      WHERE l."retiredAt" IS NULL
        AND (${category.all}::boolean OR c.slug = ${category.exact} OR c.slug LIKE ${category.children})
        AND (${filter.durationMin}::float8 IS NULL OR l."durationSec" >= ${filter.durationMin}::float8)
        AND (${filter.durationMax}::float8 IS NULL OR l."durationSec" <= ${filter.durationMax}::float8)
        AND (${filter.mood}::text IS NULL OR a."moodTag" ILIKE ${filter.mood}::text)
        AND l.tags @> ${filter.tags}::text[]
    ) ranked
    WHERE (1 - ranked.distance) >= ${MIN_SIMILARITY} OR ranked.boost > 0
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
