import type { PrismaClient } from '@prisma/client';
import { ConfigurationError, UpstreamServiceError, ValidationError } from '../../errors';
import type { AssetStorage } from '../storage';

// BACKLOG 14.1 — an organisation's S3 objects. Every tenant object Studio writes lives under
// orgs/<organisationId>/ (storage.ts providerOutputKey, uploads, images/ingest.ts, voice consent,
// overlay pre-renders), in the assets, renders and thumbnails buckets. The library bucket holds the
// platform corpus under library/ (no org prefix) and is only included because it is configured.
// Only keys under the organisation's own prefix are ever deleted: a row that points at an object
// elsewhere (e.g. a shared corpus or stock object) is reported, never deleted.

/** Same rule as storage.ts SAFE_KEY_SEGMENT: no '/', no '..'-only segment, bounded length. */
const SAFE_ORG_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

export function orgPrefix(organisationId: string): string {
  if (!SAFE_ORG_SEGMENT.test(organisationId)) {
    throw new ValidationError('Organisation id is not usable as a storage prefix');
  }
  return `orgs/${organisationId}/`;
}

/**
 * Studio's configured buckets (S3_BUCKET_ASSETS / RENDERS / THUMBNAILS / LIBRARY) and their
 * 15.E9 fallback-region buckets (S3_FALLBACK_BUCKET_*): during a primary outage objects land in
 * the fallback bucket under the same orgs/<id>/ key, and thumbnails record no bucket on their row.
 */
export function purgeBucketsFromEnv(env: Record<string, string | undefined> = process.env) {
  const names = [
    env.S3_BUCKET_ASSETS,
    env.S3_BUCKET_RENDERS,
    env.S3_BUCKET_THUMBNAILS,
    env.S3_BUCKET_LIBRARY,
    env.S3_FALLBACK_BUCKET_ASSETS,
    env.S3_FALLBACK_BUCKET_RENDERS,
    env.S3_FALLBACK_BUCKET_THUMBNAILS,
    env.S3_FALLBACK_BUCKET_LIBRARY,
  ].flatMap((b) => (b?.trim() ? [b.trim()] : []));
  return [...new Set(names)];
}

/** Configured buckets plus any other bucket the organisation's rows point at. */
export async function bucketsFor(
  db: PrismaClient,
  organisationId: string,
  configured: string[],
): Promise<string[]> {
  const rows = await db.$queryRaw<{ bucket: string | null }[]>`
    SELECT DISTINCT "s3Bucket" AS bucket FROM "studio"."video_assets" WHERE "organisationId" = ${organisationId}
    UNION SELECT DISTINCT "s3Bucket" FROM "studio"."video_renders"
      WHERE "projectId" IN (SELECT "id" FROM "studio"."video_projects" WHERE "organisationId" = ${organisationId})
    UNION SELECT DISTINCT "s3Bucket" FROM "studio"."image_library" WHERE "organisationId" = ${organisationId}
    UNION SELECT DISTINCT "s3Bucket" FROM "studio"."video_uploads" WHERE "organisationId" = ${organisationId}
    UNION SELECT DISTINCT "consentS3Bucket" FROM "studio"."voice_profiles" WHERE "organisationId" = ${organisationId}
    UNION SELECT DISTINCT "s3Bucket" FROM "studio"."data_exports" WHERE "organisationId" = ${organisationId}`;
  const fromRows = rows.flatMap((r) => (r.bucket?.trim() ? [r.bucket.trim()] : []));
  return [...new Set([...configured, ...fromRows])].sort();
}

/** Row-referenced keys of the organisation that are NOT under its prefix (reported only). */
export async function countKeysOutsidePrefix(
  db: PrismaClient,
  organisationId: string,
): Promise<number> {
  // A plain "starts with" comparison, not LIKE: the organisation id may contain '_' or '%',
  // which are LIKE wildcards and would make the pattern match keys it should not, undercounting
  // rows whose key sits outside the prefix (see purge-storage.test.ts). strpos(key, prefix) = 1
  // means the key starts with the prefix; strpos never treats the prefix as a pattern.
  const prefix = orgPrefix(organisationId);
  const rows = await db.$queryRaw<{ n: number }[]>`
    SELECT (
      (SELECT count(*) FROM "studio"."video_assets" WHERE "organisationId" = ${organisationId} AND "s3Key" <> '' AND strpos("s3Key", ${prefix}) <> 1)
      + (SELECT count(*) FROM "studio"."image_library" WHERE "organisationId" = ${organisationId} AND "s3Key" <> '' AND strpos("s3Key", ${prefix}) <> 1)
      + (SELECT count(*) FROM "studio"."video_uploads" WHERE "organisationId" = ${organisationId} AND strpos("s3Key", ${prefix}) <> 1)
    )::int AS n`;
  return rows[0]?.n ?? 0;
}

export interface PrefixCount {
  bucket: string;
  prefix: string;
  objects: number;
  bytes: number;
  /** True when the dry run stopped counting at maxPages pages. */
  truncated: boolean;
}

function requireListing(storage: AssetStorage) {
  const { list, deleteMany } = storage;
  if (!list || !deleteMany) {
    throw new ConfigurationError('The asset storage cannot list or batch-delete objects');
  }
  return { list: list.bind(storage), deleteMany: deleteMany.bind(storage) };
}

/** Dry run: counts objects under the prefix, at most `maxPages` × 1,000. */
export async function countPrefix(
  storage: AssetStorage,
  bucket: string,
  prefix: string,
  maxPages = 10,
): Promise<PrefixCount> {
  const { list } = requireListing(storage);
  let objects = 0;
  let bytes = 0;
  let token: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const listed = await list(bucket, prefix, token);
    objects += listed.objects.length;
    bytes += listed.objects.reduce((n, o) => n + o.size, 0);
    token = listed.nextToken;
    if (!token) return { bucket, prefix, objects, bytes, truncated: false };
  }
  return { bucket, prefix, objects, bytes, truncated: true };
}

/**
 * Deletes every object under the prefix, a page (≤ 1,000 keys) at a time. Re-lists from the
 * start after each batch, so it is idempotent and resumes cleanly after a crash. Throws when S3
 * refuses keys (e.g. AccessDenied) so the purge stays in hard_deleting and is retried.
 */
export async function deletePrefix(
  storage: AssetStorage,
  bucket: string,
  prefix: string,
): Promise<{ objects: number; bytes: number }> {
  const { list, deleteMany } = requireListing(storage);
  let objects = 0;
  let bytes = 0;
  for (;;) {
    const listed = await list(bucket, prefix);
    if (listed.objects.length === 0) return { objects, bytes };
    const result = await deleteMany(
      bucket,
      listed.objects.map((o) => o.key),
    );
    if (result.errors.length) {
      throw new UpstreamServiceError(
        `S3 refused ${result.errors.length} deletes in ${bucket}/${prefix}`,
        { first: result.errors[0] },
      );
    }
    objects += result.deleted;
    bytes += listed.objects.reduce((n, o) => n + o.size, 0);
  }
}
