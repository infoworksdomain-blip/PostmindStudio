import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { NotFoundError, ProviderError, ValidationError } from '../../errors';
import type { PipelineDeps } from '../pipeline/deps';
import type { ProviderRunDeps } from '../pipeline/provider-run';
import { runProvider } from '../pipeline/provider-run';
import type { AspectRatio } from '../providers/interface';
import { publicErrorText } from '../providers/provider-errors';
import type { PlanTier } from '../providers/router';
import type { AssetStorage } from '../storage';
import {
  embeddingText,
  ingestImage,
  normaliseTags,
  recordHotlinkedImage,
  vectorLiteral,
  type IngestOutcome,
} from './ingest';
import type { StockHit, StockImageSource } from './stock';
import { vectorSql } from '../vector-sql';

// BACKLOG 6.4 / 6.7 — image-library operations shared by the scan worker and the API:
// stock layer (A6.3 Layer 2), on-demand generation (Layer 3), embeddings and similarity search.

export const EMBEDDING_DIMENSIONS = 1536;
const EMBED_BATCH = 64;
const STOCK_PER_QUERY = 20;
const MAX_STOCK_QUERIES = 10;

export interface LibraryDeps {
  db: PrismaClient;
  storage: AssetStorage;
  bucket: string;
  fetchImpl: typeof fetch;
  providers: ProviderRunDeps;
  stock: () => { primary: StockImageSource[]; fallback: StockImageSource[] };
  logger: Logger;
}

/** Library deps from the pipeline wiring (workers and API share one code path). */
export function libraryDepsFrom(pipeline: PipelineDeps): LibraryDeps {
  return {
    db: pipeline.db,
    storage: pipeline.storage,
    bucket: pipeline.config.assetsBucket,
    fetchImpl: pipeline.scan.pageFetch,
    providers: pipeline,
    stock: pipeline.scan.stock,
    logger: pipeline.logger,
  };
}

export interface BusinessScope {
  organisationId: string;
  businessId: string;
  planTier: PlanTier;
}

export interface StockLayerResult {
  created: number;
  duplicates: number;
  skipped: number;
  errors: string[];
}

function licenceNote(hit: StockHit): string {
  const credit = hit.attribution
    ? `Photo by ${hit.attribution.name}${hit.attribution.url ? ` (${hit.attribution.url})` : ''}`
    : null;
  const terms: Record<StockHit['provider'], string> = {
    pexels: 'Pexels licence (https://www.pexels.com/license/)',
    storyblocks: 'Storyblocks licence (per agreement)',
    unsplash: 'Unsplash licence — hotlink only; report use to download_location',
  };
  return [terms[hit.provider], credit, hit.trackUseUrl ? `track:${hit.trackUseUrl}` : null]
    .filter(Boolean)
    .join('; ');
}

/** A6.3 Layer 2: run each query against the stock sources, dedupe across queries, store. */
export async function buildStockLayer(
  deps: LibraryDeps,
  scope: BusinessScope,
  input: { queries: string[]; themes: string[] },
): Promise<StockLayerResult> {
  const result: StockLayerResult = { created: 0, duplicates: 0, skipped: 0, errors: [] };
  const queries = [...new Set(input.queries.map((q) => q.trim()).filter(Boolean))].slice(
    0,
    MAX_STOCK_QUERIES,
  );
  if (queries.length === 0) return result;
  const { primary, fallback } = deps.stock();
  const seen = new Set<string>();
  const ids = { userId: scope.organisationId, projectId: scope.businessId };

  const tally = (outcome: IngestOutcome) => {
    if (outcome.status === 'created') result.created += 1;
    else if (outcome.status === 'duplicate') result.duplicates += 1;
    else result.skipped += 1;
  };

  for (const query of queries) {
    let hits = 0;
    for (const sources of [primary, fallback]) {
      if (hits > 0) break; // fallback only when the primaries found nothing
      for (const source of sources) {
        let found: StockHit[];
        try {
          found = await source.search({ query, perPage: STOCK_PER_QUERY, ...ids });
        } catch (err) {
          result.errors.push(`${source.provider} "${query}": ${publicErrorText(err)}`);
          continue;
        }
        await deps.db.imageLibraryQuery.upsert({
          where: {
            businessId_provider_query: {
              businessId: scope.businessId,
              provider: source.provider,
              query,
            },
          },
          create: {
            businessId: scope.businessId,
            provider: source.provider,
            query,
            resultCount: found.length,
          },
          update: { resultCount: found.length, lastRunAt: new Date() },
        });
        hits += found.length;
        for (const hit of found) {
          const key = `${hit.provider}:${hit.providerImageId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const tags = normaliseTags([query, ...input.themes.slice(0, 5)]);
          try {
            if (!hit.storable) {
              tally(
                await recordHotlinkedImage(deps.db, {
                  ...scope,
                  provider: hit.provider,
                  providerImageId: hit.providerImageId,
                  url: hit.imageUrl,
                  width: hit.width,
                  height: hit.height,
                  altText: hit.alt,
                  tags,
                  licenseNotes: licenceNote(hit),
                  pageUrl: hit.pageUrl,
                }),
              );
              continue;
            }
            tally(
              await ingestImage(deps, {
                organisationId: scope.organisationId,
                businessId: scope.businessId,
                source: 'STOCK',
                sourceUrl: hit.pageUrl ?? hit.imageUrl,
                sourceProvider: hit.provider,
                downloadUrl: await source.downloadUrl(hit, ids),
                altText: hit.alt,
                tags,
                licenseNotes: licenceNote(hit),
              }),
            );
          } catch (err) {
            result.errors.push(`${key}: ${publicErrorText(err)}`.slice(0, 300));
          }
        }
      }
    }
  }
  return result;
}

/** Compute embeddings for library rows that have none (A7.7 vector(1536)). */
export async function embedMissing(
  deps: Pick<LibraryDeps, 'db' | 'providers'>,
  scope: BusinessScope,
  limit = 500,
): Promise<{ embedded: number; costPence: number }> {
  const rows = await deps.db.$queryRaw<
    Array<{
      id: string;
      altText: string | null;
      tags: string[];
      generatedFromPrompt: string | null;
    }>
  >`SELECT id, "altText", tags, "generatedFromPrompt" FROM studio.image_library
    WHERE "businessId" = ${scope.businessId} AND "organisationId" = ${scope.organisationId}
      AND embedding IS NULL
    ORDER BY "createdAt" LIMIT ${limit}`;
  const texts = rows.map((r) => ({ id: r.id, text: embeddingText(r) })).filter((r) => r.text);
  let embedded = 0;
  let costPence = 0;
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const vectors = await embed(
      deps,
      scope,
      batch.map((b) => b.text),
    );
    costPence += vectors.costPence;
    for (const [index, row] of batch.entries()) {
      const vector = vectors.embeddings[index];
      if (!vector) continue;
      const v = await vectorSql(deps.db);
      await deps.db.$executeRaw`UPDATE studio.image_library
        SET embedding = ${vectorLiteral(vector)}${v.cast}
        WHERE id = ${row.id} AND "organisationId" = ${scope.organisationId}`;
      embedded += 1;
    }
  }
  return { embedded, costPence };
}

async function embed(
  deps: Pick<LibraryDeps, 'providers'>,
  scope: BusinessScope,
  input: string[],
): Promise<{ embeddings: number[][]; costPence: number }> {
  const run = await runProvider(
    {
      need: { kind: 'capability', capability: 'embedding' },
      planTier: scope.planTier,
      request: {
        capability: 'embedding',
        organisationId: scope.organisationId,
        input,
        dimensions: EMBEDDING_DIMENSIONS,
      },
    },
    deps.providers,
  );
  const metadata = run.output.metadata as { embeddings?: unknown; costPence?: number };
  const embeddings = metadata.embeddings;
  if (
    !Array.isArray(embeddings) ||
    embeddings.length !== input.length ||
    !embeddings.every((e) => Array.isArray(e) && e.length === EMBEDDING_DIMENSIONS)
  ) {
    throw new ProviderError('embedding', 'unknown', 'Embedding output had the wrong shape', true);
  }
  return { embeddings: embeddings as number[][], costPence: metadata.costPence ?? 0 };
}

export interface SearchHit {
  id: string;
  similarity: number;
}

/** BACKLOG 6.7 — pgvector cosine search over image descriptions. */
export async function searchLibrary(
  deps: Pick<LibraryDeps, 'db' | 'providers'>,
  scope: BusinessScope,
  query: string,
  limit: number,
): Promise<SearchHit[]> {
  const text = query.trim();
  if (!text) throw new ValidationError('query must not be empty');
  const { embeddings } = await embed(deps, scope, [text]);
  const vector = vectorLiteral(embeddings[0] as number[]);
  const v = await vectorSql(deps.db);
  const rows = await deps.db.$queryRaw<Array<{ id: string; distance: number }>>`
    SELECT id, (embedding ${v.distance} ${vector}${v.cast})::float8 AS distance
    FROM studio.image_library
    WHERE "businessId" = ${scope.businessId} AND "organisationId" = ${scope.organisationId}
      AND embedding IS NOT NULL
    ORDER BY embedding ${v.distance} ${vector}${v.cast}
    LIMIT ${limit}`;
  return rows.map((r) => ({ id: r.id, similarity: Number((1 - r.distance).toFixed(4)) }));
}

/** A6.3 Layer 3 — generate an image on demand and keep it in the library. */
export async function generateLibraryImage(
  deps: LibraryDeps,
  scope: BusinessScope,
  input: { prompt: string; aspectRatio: AspectRatio; style?: string },
): Promise<IngestOutcome> {
  const profile = await deps.db.businessProfile.findFirst({
    where: { businessId: scope.businessId, organisationId: scope.organisationId },
  });
  const prompt = [
    input.prompt.trim(),
    input.style ? `Style: ${input.style.trim()}` : null,
    profile
      ? `Brand context: ${profile.subNiche}; themes: ${profile.imageThemes.join(', ')}`
      : null,
    'No text, logos or watermarks in the image.',
  ]
    .filter(Boolean)
    .join('\n');
  const run = await runProvider(
    {
      // Routed like an IMAGE_STILL shot (spec 6.4), so plan tier and fallbacks apply.
      need: { kind: 'shot', visualTreatment: 'IMAGE_STILL', durationSec: 5 },
      planTier: scope.planTier,
      request: {
        capability: 'text_to_image',
        organisationId: scope.organisationId,
        prompt,
        aspectRatio: input.aspectRatio,
      },
    },
    deps.providers,
  );
  const metadata = run.output.metadata as { s3Bucket?: string; s3Key?: string };
  if (!metadata.s3Bucket || !metadata.s3Key) {
    throw new ProviderError('text_to_image', 'unknown', 'Generated image was not stored', true);
  }
  const size = await deps.storage.size(metadata.s3Bucket, metadata.s3Key);
  const bytes = await deps.storage.readRange(metadata.s3Bucket, metadata.s3Key, 0, size - 1);
  return ingestImage(deps, {
    organisationId: scope.organisationId,
    businessId: scope.businessId,
    source: 'GENERATED',
    sourceProvider: run.decision.adapter.providerId,
    bytes,
    altText: input.prompt.trim().slice(0, 500),
    tags: profile?.imageThemes.slice(0, 5) ?? [],
    generatedFromPrompt: prompt,
    licenseNotes: `Generated by ${run.decision.adapter.providerId}`,
  });
}

export async function deleteLibraryImage(
  deps: Pick<LibraryDeps, 'db' | 'storage'>,
  organisationId: string,
  id: string,
): Promise<void> {
  const item = await deps.db.imageLibraryItem.findFirst({ where: { id, organisationId } });
  if (!item) throw new NotFoundError('Image not found');
  await deps.db.imageLibraryItem.delete({ where: { id } });
  if (item.s3Key) await deps.storage.delete(item.s3Bucket, item.s3Key);
}
