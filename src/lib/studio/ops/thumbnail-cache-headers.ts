import {
  CopyObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { Logger } from 'pino';
import { ValidationError } from '../../errors';
import { THUMBNAIL_CACHE_CONTROL } from '../library/thumbnail-signing';

// BACKLOG 20.15 — one-off backfill: give library thumbnails ingested before 20.15 the
// Cache-Control new uploads get (thumbnail-signing.ts THUMBNAIL_CACHE_CONTROL), so browsers keep
// them for the whole stable-URL window. Each object is copied onto itself with
// MetadataDirective=REPLACE (S3 and R2 both refuse a self-copy that changes nothing, and REPLACE
// is what lets new system metadata in); Content-Type, the other content headers and the user
// metadata are carried over from HeadObject. Objects already carrying the value are skipped,
// so the run is idempotent and can be resumed.
//   S3 CopyObject: https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html
//   R2 supports CopyObject with x-amz-metadata-directive, Content-Type and Cache-Control
//   (https://developers.cloudflare.com/r2/api/s3/api/, read 2026-10-01); it does not support
//   x-amz-tagging-directive, so none is sent (S3's default, COPY, keeps tags).

/** Keys ingest.ts writes for thumbnails: library/<sha256>-thumb.jpg. */
export const THUMBNAIL_KEY = /^library\/[^/]+-thumb\.jpg$/;
export const LIBRARY_PREFIX = 'library/';

export interface CacheHeaderBackfillOptions {
  bucket: string;
  dryRun: boolean;
  /** Stop after this many matching objects (a trial run); undefined = all. */
  limit?: number;
  cacheControl?: string;
  prefix?: string;
}

export interface CacheHeaderBackfillReport {
  dryRun: boolean;
  scanned: number;
  matched: number;
  alreadySet: number;
  /** Updated (or, in a dry run, would be). */
  updated: number;
  failed: Array<{ key: string; message: string }>;
}

/** CopySource is "bucket/key" with each key segment URL-encoded. */
export function copySource(bucket: string, key: string): string {
  return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

async function updateOne(
  client: Pick<S3Client, 'send'>,
  bucket: string,
  key: string,
  options: { dryRun: boolean; cacheControl: string },
): Promise<'already' | 'updated'> {
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  if (head.CacheControl === options.cacheControl) return 'already';
  if (options.dryRun) return 'updated';
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: key,
      CopySource: copySource(bucket, key),
      MetadataDirective: 'REPLACE',
      ContentType: head.ContentType ?? 'image/jpeg',
      CacheControl: options.cacheControl,
      ...(head.ContentDisposition && { ContentDisposition: head.ContentDisposition }),
      ...(head.ContentEncoding && { ContentEncoding: head.ContentEncoding }),
      ...(head.ContentLanguage && { ContentLanguage: head.ContentLanguage }),
      ...(head.Metadata && { Metadata: head.Metadata }),
    }),
  );
  return 'updated';
}

export async function backfillThumbnailCacheHeaders(
  client: Pick<S3Client, 'send'>,
  options: CacheHeaderBackfillOptions,
  log?: Pick<Logger, 'info' | 'warn'>,
): Promise<CacheHeaderBackfillReport> {
  if (!options.bucket.trim()) throw new ValidationError('bucket is required');
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1))
    throw new ValidationError('limit must be a positive integer');
  const cacheControl = options.cacheControl ?? THUMBNAIL_CACHE_CONTROL;
  const report: CacheHeaderBackfillReport = {
    dryRun: options.dryRun,
    scanned: 0,
    matched: 0,
    alreadySet: 0,
    updated: 0,
    failed: [],
  };
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: options.bucket,
        Prefix: options.prefix ?? LIBRARY_PREFIX,
        ContinuationToken: token,
      }),
    );
    for (const object of page.Contents ?? []) {
      if (options.limit !== undefined && report.matched >= options.limit) return report;
      report.scanned += 1;
      const key = object.Key;
      if (!key || !THUMBNAIL_KEY.test(key)) continue;
      report.matched += 1;
      try {
        const outcome = await updateOne(client, options.bucket, key, {
          dryRun: options.dryRun,
          cacheControl,
        });
        if (outcome === 'already') report.alreadySet += 1;
        else report.updated += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        report.failed.push({ key, message });
        log?.warn({ key, err: message }, 'thumbnail cache header: object failed');
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    log?.info({ ...report, failed: report.failed.length }, 'thumbnail cache header: progress');
  } while (token);
  return report;
}

export interface BackfillArgs {
  dryRun: boolean;
  limit?: number;
  bucket?: string;
}

/** CLI flags: --dry-run, --limit <n>, --bucket <name> (default S3_BUCKET_LIBRARY). */
export function parseBackfillArgs(argv: string[]): BackfillArgs {
  const args: BackfillArgs = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--limit' || flag === '--bucket') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new ValidationError(`${flag} needs a value`);
      i += 1;
      if (flag === '--bucket') args.bucket = value;
      else {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1)
          throw new ValidationError('--limit must be a positive integer');
        args.limit = n;
      }
    } else throw new ValidationError(`unknown option ${flag}`);
  }
  return args;
}
