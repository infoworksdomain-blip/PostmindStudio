import { ConfigurationError, ValidationError } from '../../errors';

// Corpus sources (BACKLOG 9.2/9.3). A library item's source is either a public http(s) URL,
// fetched through the SSRF guard (scan/safe-fetch.ts), or an s3://bucket/key object in a bucket
// the operator allow-listed with STUDIO_CORPUS_S3_BUCKETS, read with Studio's own storage client.
// The allow-list is the only way to reach a non-public source: http(s) never bypasses the guard.

/** S3 bucket naming rules (3–63 chars, lowercase letters, digits, dots and hyphens). */
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export interface S3Source {
  bucket: string;
  key: string;
}

/** One allow-list entry: a whole bucket, or only keys under a prefix of it. */
export interface AllowedCorpusBucket {
  bucket: string;
  prefix: string;
}

export function isS3Url(raw: string): boolean {
  return raw.startsWith('s3://');
}

/** s3://bucket/key → { bucket, key }; throws ValidationError for anything malformed. */
export function parseS3Url(raw: string): S3Source {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(raw);
  if (!match) throw new ValidationError('S3 sources must look like s3://bucket/key');
  const bucket = match[1] as string;
  const key = match[2] as string;
  if (!BUCKET_NAME.test(bucket)) throw new ValidationError('Not a valid S3 bucket name');
  if (key.split('/').some((segment) => segment === '..' || segment === '.'))
    throw new ValidationError('S3 keys may not contain . or .. segments');
  if ([...key].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f))
    throw new ValidationError('S3 keys may not contain control characters');
  return { bucket, key };
}

/** True for URLs the ingest endpoint accepts at all (the allow-list is checked at ingest). */
export function isSupportedSourceUrl(raw: string): boolean {
  if (isS3Url(raw)) {
    try {
      parseS3Url(raw);
      return true;
    } catch {
      return false;
    }
  }
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * STUDIO_CORPUS_S3_BUCKETS: comma-separated `bucket` or `bucket/prefix/` entries. Invalid
 * entries are a configuration error (fail loudly rather than silently allow less or more).
 */
export function parseCorpusBuckets(raw: string | undefined): AllowedCorpusBucket[] {
  const entries = (raw ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  return entries.map((entry) => {
    const slash = entry.indexOf('/');
    const bucket = slash === -1 ? entry : entry.slice(0, slash);
    const prefix = slash === -1 ? '' : entry.slice(slash + 1);
    if (!BUCKET_NAME.test(bucket))
      throw new ConfigurationError(`STUDIO_CORPUS_S3_BUCKETS: invalid bucket name "${bucket}"`);
    if (prefix.split('/').some((s) => s === '..' || s === '.'))
      throw new ConfigurationError(`STUDIO_CORPUS_S3_BUCKETS: invalid prefix in "${entry}"`);
    return { bucket, prefix };
  });
}

/**
 * True when `key` is the prefix itself or sits under it as a path segment. A plain
 * `startsWith` would let an allow-listed prefix like "corpus" also match a sibling key such as
 * "corpus-evil/x" — a prefix-collision bypass — so the character after the prefix (if any) must
 * be a `/` (or the prefix must already end in one, or be empty for a whole-bucket entry).
 */
function keyUnderPrefix(key: string, prefix: string): boolean {
  if (prefix === '') return true;
  if (!key.startsWith(prefix)) return false;
  return prefix.endsWith('/') || key.length === prefix.length || key[prefix.length] === '/';
}

/** Throws unless the object sits in an allow-listed bucket (and under its prefix, if any). */
export function assertAllowedS3Source(
  source: S3Source,
  allowed: readonly AllowedCorpusBucket[],
): void {
  if (allowed.length === 0)
    throw new ValidationError(
      's3:// sources are disabled: set STUDIO_CORPUS_S3_BUCKETS to allow a corpus bucket',
    );
  const ok = allowed.some(
    (a) => a.bucket === source.bucket && keyUnderPrefix(source.key, a.prefix),
  );
  if (!ok)
    throw new ValidationError(
      `s3://${source.bucket}/… is not in STUDIO_CORPUS_S3_BUCKETS (allow-listed corpus buckets)`,
    );
}
