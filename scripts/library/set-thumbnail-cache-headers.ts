import { ConfigurationError } from '../../src/lib/errors';
import { logger } from '../../src/lib/logger';
import {
  backfillThumbnailCacheHeaders,
  parseBackfillArgs,
} from '../../src/lib/studio/ops/thumbnail-cache-headers';
import { createStorageS3Client } from '../../src/lib/studio/storage-client';

// BACKLOG 20.15 — one-off: set Cache-Control "public, max-age=604800, immutable" on the library
// thumbnails ingested before 20.15 (new ingests set it at upload). Copies each
// library/<hash>-thumb.jpg onto itself with MetadataDirective=REPLACE, keeping Content-Type and
// user metadata; objects that already carry the header are skipped (safe to re-run).
// Logic and tests: src/lib/studio/ops/thumbnail-cache-headers.ts. Runbook:
// runbooks/corpus-ingestion.md "Library caching".
//
//   npx tsx scripts/library/set-thumbnail-cache-headers.ts --dry-run          # count only
//   npx tsx scripts/library/set-thumbnail-cache-headers.ts --limit 20         # trial batch
//   npx tsx scripts/library/set-thumbnail-cache-headers.ts                    # everything
//   ... [--bucket <name>]   (default S3_BUCKET_LIBRARY)
//
// Needs the storage env of the target (STORAGE_PROVIDER, R2_* or AWS_*) with a token that can
// read and write objects in the library bucket (the app's Object Read & Write token is enough).

async function main(): Promise<void> {
  const args = parseBackfillArgs(process.argv.slice(2));
  const bucket = args.bucket ?? process.env.S3_BUCKET_LIBRARY?.trim();
  if (!bucket) throw new ConfigurationError('Set S3_BUCKET_LIBRARY or pass --bucket');
  const report = await backfillThumbnailCacheHeaders(
    createStorageS3Client(),
    { bucket, dryRun: args.dryRun, limit: args.limit },
    logger,
  );
  logger.info(
    { ...report, failed: report.failed.slice(0, 20), failedCount: report.failed.length },
    args.dryRun ? 'dry run: nothing written' : 'thumbnail Cache-Control backfill finished',
  );
  if (report.failed.length > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  logger.error({ err }, 'thumbnail Cache-Control backfill failed');
  process.exitCode = 1;
});
