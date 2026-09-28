import type { PrismaClient } from '@prisma/client';
import { NotFoundError, ProviderError } from '../../errors';
import { vectorLiteral } from '../images/ingest';
import { vectorSql } from '../vector-sql';
import type { ProviderRunDeps } from '../pipeline/provider-run';
import { runProvider } from '../pipeline/provider-run';
import type { PlanTier } from '../providers/router';

// BACKLOG 9.4 / Addendum A3.5 — pgvector nearest-neighbour search over the library.
// The A7.4 schema stores one 1536-d vector per video (embedding of its analysed description),
// so the visual/audio/text weights recorded on each row are informational: similarity is a
// single cosine distance. Retired items never appear, and neither do rows without a
// video_library_licenses row (Addendum A11.1: "Rows without a licence status are unusable — the
// API rejects them from search results"; BACKLOG 15.D7).

export interface SimilarHit {
  id: string;
  similarity: number;
}

const round = (d: number) => Number((1 - d).toFixed(4));

/** Operation 1 — "more like this". */
export async function similarVideos(
  db: PrismaClient,
  libraryItemId: string,
  limit: number,
): Promise<SimilarHit[]> {
  const v = await vectorSql(db);
  const rows = await db.$queryRaw<Array<{ id: string; distance: number }>>`
    SELECT l.id, (e.embedding ${v.distance} src.embedding)::float8 AS distance
    FROM studio.video_library_embeddings e
    JOIN studio.video_library l ON l.id = e."libraryItemId"
    JOIN studio.video_library_licenses lic ON lic."libraryItemId" = l.id
    JOIN studio.video_library_embeddings src ON src."libraryItemId" = ${libraryItemId}
    JOIN studio.video_library_licenses srclic ON srclic."libraryItemId" = ${libraryItemId}
    WHERE l."retiredAt" IS NULL AND l.id <> ${libraryItemId}
    ORDER BY e.embedding ${v.distance} src.embedding
    LIMIT ${limit}`;
  if (rows.length === 0) {
    const exists = await db.videoLibraryItem.findFirst({
      where: { id: libraryItemId, retiredAt: null, license: { isNot: null } },
      select: { id: true },
    });
    if (!exists) throw new NotFoundError('Library video not found');
  }
  return rows.map((r) => ({ id: r.id, similarity: round(r.distance) }));
}

export function profileDocument(profile: {
  industry: string;
  subNiche: string;
  products: string[];
  services: string[];
  audienceKeywords: string[];
  toneIndicators: string[];
  imageThemes: string[];
  brandVoiceSummary: string | null;
}): string {
  return [
    `${profile.subNiche} (${profile.industry})`,
    profile.products.length ? `Products: ${profile.products.join(', ')}` : '',
    profile.services.length ? `Services: ${profile.services.join(', ')}` : '',
    profile.audienceKeywords.length ? `Audience: ${profile.audienceKeywords.join(', ')}` : '',
    profile.toneIndicators.length ? `Tone: ${profile.toneIndicators.join(', ')}` : '',
    profile.imageThemes.length ? `Themes: ${profile.imageThemes.join(', ')}` : '',
    profile.brandVoiceSummary ?? '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Operation 2 — "good references for me": nearest to the business profile, optional category. */
export async function recommendedVideos(
  deps: { db: PrismaClient; providers: ProviderRunDeps },
  scope: { organisationId: string; businessId: string; planTier: PlanTier },
  options: { limit: number; categorySlug?: string },
): Promise<SimilarHit[]> {
  const profile = await deps.db.businessProfile.findFirst({
    where: { organisationId: scope.organisationId, businessId: scope.businessId },
  });
  if (!profile) throw new NotFoundError('No business profile yet: run a website scan first');
  const run = await runProvider(
    {
      need: { kind: 'capability', capability: 'embedding' },
      planTier: scope.planTier,
      request: {
        capability: 'embedding',
        organisationId: scope.organisationId,
        input: [profileDocument(profile)],
        dimensions: 1536,
      },
    },
    deps.providers,
  );
  const vector = (run.output.metadata as { embeddings?: number[][] }).embeddings?.[0];
  if (!vector || vector.length !== 1536)
    throw new ProviderError('embedding', 'unknown', 'Embedding had the wrong shape', true);
  const literal = vectorLiteral(vector);
  const prefix = options.categorySlug ? `${options.categorySlug.replace(/[%_\\]/g, '')}%` : '%';
  const v = await vectorSql(deps.db);
  const rows = await deps.db.$queryRaw<Array<{ id: string; distance: number }>>`
    SELECT l.id, (e.embedding ${v.distance} ${literal}${v.cast})::float8 AS distance
    FROM studio.video_library_embeddings e
    JOIN studio.video_library l ON l.id = e."libraryItemId"
    JOIN studio.video_library_categories c ON c.id = l."categoryId"
    JOIN studio.video_library_licenses lic ON lic."libraryItemId" = l.id
    WHERE l."retiredAt" IS NULL AND c.slug LIKE ${prefix}
    ORDER BY e.embedding ${v.distance} ${literal}${v.cast}
    LIMIT ${options.limit}`;
  return rows.map((r) => ({ id: r.id, similarity: round(r.distance) }));
}
