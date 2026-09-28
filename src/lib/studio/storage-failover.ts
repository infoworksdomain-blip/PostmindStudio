import type { Logger } from 'pino';
import { ConfigurationError } from '../errors';
import type { AssetStorage, StoredObject } from './storage';

// BACKLOG 15.E9 — spec 4.6 "Storage failures (S3 outage) fall back to a secondary region bucket."
// A decorator over two AssetStorage clients (primary region, S3_FALLBACK_REGION):
//   - put: primary first; when the primary fails with an OUTAGE (network error, timeout or an
//     HTTP 5xx — never a 4xx such as AccessDenied, which a second bucket would only hide) the object
//     is written to the mapped fallback bucket, and the returned { bucket } is the fallback bucket.
//     Every caller already stores the bucket next to the key (video_assets.s3Bucket,
//     video_renders.s3Bucket, …), so the object's real location is recorded without new columns.
//   - reads of an object recorded in a fallback bucket go to the fallback client directly;
//     reads of a primary-bucket object (size, readRange) try the primary, then the same key in
//     the mapped fallback bucket (covers replicated objects during a primary outage);
//     signedUrl only signs (no network call), so it signs against wherever the row says it lives.
//   - delete removes the key from both (idempotent).
//   - putStream (multipart) and copy stay on the primary: a stream cannot be replayed into a
//     second bucket after a partial failure; callers already retry the job.
// DevOps creates the fallback buckets (and, optionally, cross-region replication) — see
// runbooks/storage-failover.md. Unset S3_FALLBACK_REGION = no failover (the plain primary).

export interface FailoverConfig {
  region: string;
  /** primary bucket name → fallback bucket name */
  buckets: Map<string, string>;
}

const BUCKET_ENV: Array<[primary: string, fallback: string]> = [
  ['S3_BUCKET_ASSETS', 'S3_FALLBACK_BUCKET_ASSETS'],
  ['S3_BUCKET_RENDERS', 'S3_FALLBACK_BUCKET_RENDERS'],
  ['S3_BUCKET_THUMBNAILS', 'S3_FALLBACK_BUCKET_THUMBNAILS'],
  ['S3_BUCKET_LIBRARY', 'S3_FALLBACK_BUCKET_LIBRARY'],
];

/** Failover config from env, or undefined when S3_FALLBACK_REGION is unset. */
export function failoverConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): FailoverConfig | undefined {
  const region = env.S3_FALLBACK_REGION?.trim();
  if (!region) return undefined;
  if (region === env.AWS_REGION?.trim())
    throw new ConfigurationError('S3_FALLBACK_REGION must differ from AWS_REGION');
  const buckets = new Map<string, string>();
  for (const [primaryVar, fallbackVar] of BUCKET_ENV) {
    const primary = env[primaryVar]?.trim();
    const fallback = env[fallbackVar]?.trim();
    if (primary && fallback) {
      if (primary === fallback)
        throw new ConfigurationError(`${fallbackVar} must differ from ${primaryVar}`);
      buckets.set(primary, fallback);
    }
  }
  if (buckets.size === 0)
    throw new ConfigurationError(
      'S3_FALLBACK_REGION is set but no S3_FALLBACK_BUCKET_* matches a configured primary bucket',
    );
  return { region, buckets };
}

interface AwsLikeError {
  name?: string;
  $metadata?: { httpStatusCode?: number };
}

/** True for failures a second region can help with: network errors, timeouts and 5xx. */
export function isOutage(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = (err as AwsLikeError).$metadata?.httpStatusCode;
  if (typeof status === 'number') return status >= 500;
  const name = (err as AwsLikeError).name ?? '';
  // No HTTP response at all: DNS / socket / timeout errors from the SDK's HTTP handler.
  return name !== 'NoSuchKey' && name !== 'NotFound';
}

export function createFailoverStorage(
  primary: AssetStorage,
  fallback: AssetStorage,
  config: FailoverConfig,
  logger: Pick<Logger, 'warn'>,
): AssetStorage {
  const fallbackBuckets = new Set(config.buckets.values());
  const isFallbackBucket = (bucket: string) => fallbackBuckets.has(bucket);

  async function readWithFailover<T>(
    bucket: string,
    key: string,
    read: (s: AssetStorage, b: string) => Promise<T>,
  ): Promise<T> {
    if (isFallbackBucket(bucket)) return read(fallback, bucket);
    try {
      return await read(primary, bucket);
    } catch (err) {
      const mapped = config.buckets.get(bucket);
      if (!mapped) throw err;
      logger.warn({ err, bucket, key }, 'primary storage read failed; trying the fallback region');
      return read(fallback, mapped);
    }
  }

  return {
    async put(input): Promise<StoredObject> {
      if (isFallbackBucket(input.bucket)) return fallback.put(input);
      try {
        return await primary.put(input);
      } catch (err) {
        const mapped = config.buckets.get(input.bucket);
        if (!mapped || !isOutage(err)) throw err;
        logger.warn(
          { err, bucket: input.bucket, fallbackBucket: mapped, region: config.region },
          'primary storage write failed; writing to the fallback region',
        );
        return fallback.put({ ...input, bucket: mapped });
      }
    },
    signedUrl: (bucket, key, expiresInSec) =>
      (isFallbackBucket(bucket) ? fallback : primary).signedUrl(bucket, key, expiresInSec),
    size: (bucket, key) => readWithFailover(bucket, key, (s, b) => s.size(b, key)),
    readRange: (bucket, key, start, end) =>
      readWithFailover(bucket, key, (s, b) => s.readRange(b, key, start, end)),
    async delete(bucket, key) {
      if (isFallbackBucket(bucket)) return fallback.delete(bucket, key);
      await primary.delete(bucket, key);
      const mapped = config.buckets.get(bucket);
      if (mapped) await fallback.delete(mapped, key);
    },
    ...(primary.putStream && { putStream: primary.putStream.bind(primary) }),
    ...(primary.copy && { copy: primary.copy.bind(primary) }),
  };
}
