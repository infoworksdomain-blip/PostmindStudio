import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl as getCloudFrontSignedUrl } from '@aws-sdk/cloudfront-signer';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requireEnv } from '../env';
import { ConfigurationError, ValidationError } from '../errors';
import { s3Copy, s3PutStream, type StreamPutInput } from './storage-multipart';

// Object storage for provider outputs that arrive as bytes (OpenAI GPT image models return
// base64 only; ElevenLabs returns raw audio). Buckets per CLAUDE.md: studio-assets,
// studio-renders, studio-thumbnails, studio-library-assets.

export const SIGNED_URL_TTL_SEC = 24 * 60 * 60;
const SAFE_KEY_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

export interface StoredObject {
  bucket: string;
  key: string;
  url: string; // signed GET URL, valid SIGNED_URL_TTL_SEC
}

export interface AssetStorage {
  put(input: {
    bucket: string;
    key: string;
    body: Uint8Array;
    contentType: string;
  }): Promise<StoredObject>;
  signedUrl(bucket: string, key: string, expiresInSec?: number): Promise<string>;
  /** Object size in bytes. */
  size(bucket: string, key: string): Promise<number>;
  /** Bytes [start, endInclusive] of an object (for chunked platform uploads). */
  readRange(bucket: string, key: string, start: number, endInclusive: number): Promise<Uint8Array>;
  /** Remove an object (idempotent: deleting a missing key succeeds). */
  delete(bucket: string, key: string): Promise<void>;
  /** 13.15: multipart upload from a byte stream (never buffers the whole object). */
  putStream?(input: StreamPutInput): Promise<{ bucket: string; key: string; bytes: number }>;
  /** 13.15: server-side copy within a bucket. */
  copy?(bucket: string, fromKey: string, toKey: string): Promise<void>;
  /** 14.1: one page (at most 1,000) of the current objects under a key prefix. */
  list?(bucket: string, prefix: string, continuationToken?: string): Promise<ListedPage>;
  /** 14.1: delete up to 1,000 keys in one request; per-key failures are returned, not thrown. */
  deleteMany?(bucket: string, keys: string[]): Promise<DeleteManyResult>;
}

/** S3 DeleteObjects and ListObjectsV2 both cap one request at 1,000 keys. */
export const MAX_KEYS_PER_REQUEST = 1_000;

export interface ListedPage {
  objects: { key: string; size: number }[];
  /** Pass back to list() for the next page; undefined = this was the last page. */
  nextToken?: string;
}

export interface DeleteManyResult {
  deleted: number;
  errors: { key: string; code: string; message: string }[];
}

/** Deterministic, tenant-scoped key layout for provider outputs. */
export function providerOutputKey(input: {
  organisationId: string;
  projectId?: string;
  providerId: string;
  extension: string;
  id?: string;
}): string {
  const project = input.projectId ?? 'no-project';
  const id = input.id ?? randomUUID();
  // Tenant-isolation choke point: no segment may contain '/', '..' or anything unusual.
  for (const [name, value] of Object.entries({ ...input, projectId: project, id })) {
    if (!SAFE_KEY_SEGMENT.test(value)) {
      throw new ValidationError(`Unsafe S3 key segment ${name}: ${JSON.stringify(value)}`);
    }
  }
  return `orgs/${input.organisationId}/projects/${project}/providers/${input.providerId}/${id}.${input.extension}`;
}

// BACKLOG 14.2 — S3 lifecycle rules cannot match a wildcard prefix (orgs/*/projects/…), and the
// org prefix also holds uploads, scraped images and voice consent that must not expire. Provider
// outputs are therefore tagged at write time and infra/s3-lifecycle.json expires the tagged objects
// in the assets bucket (the "intermediates" of spec 17.4). A lifecycle filter can match one tag:
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/intro-lifecycle-filters.html
// PutObject Tagging is URL-query encoded ("key=value"); the writer needs s3:PutObjectTagging.
export const PROVIDER_OUTPUT_TAG = { key: 'studio-object', value: 'provider-output' } as const;
const PROVIDER_OUTPUT_KEY = /^orgs\/[^/]+\/projects\/[^/]+\/providers\//;

/** The object tagging (PutObject Tagging) for a key, or undefined for untagged objects. */
export function objectTaggingFor(key: string): string | undefined {
  return PROVIDER_OUTPUT_KEY.test(key)
    ? `${PROVIDER_OUTPUT_TAG.key}=${PROVIDER_OUTPUT_TAG.value}`
    : undefined;
}

// BACKLOG 13.30 — CloudFront signed URLs behind the same signedUrl() interface. When CDN_URL
// and a CloudFront key pair are configured, objects in CDN_BUCKET (the distribution's S3 origin;
// default S3_BUCKET_RENDERS) are served as CloudFront signed URLs with a canned policy
// (docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-creating-signed-url-canned-policy.html;
// signed with @aws-sdk/cloudfront-signer getSignedUrl({ url, keyPairId, privateKey,
// dateLessThan })). CloudFront routes by path, not by bucket, so one distribution serves one
// bucket here; every other bucket keeps S3 presigned URLs, as does everything when unset.

export interface CdnSigningConfig {
  /** Distribution origin, e.g. https://d111111abcdef8.cloudfront.net (no trailing slash). */
  baseUrl: string;
  /** The S3 bucket behind the distribution. */
  bucket: string;
  /** CloudFront public key id (key group) — CLOUDFRONT_KEY_PAIR_ID. */
  keyPairId: string;
  /** PEM private key matching that public key. */
  privateKey: string;
}

/** CDN signing from env, or undefined when CDN_URL is unset (S3 presigned URLs). */
export function cdnConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): CdnSigningConfig | undefined {
  const base = env.CDN_URL?.trim();
  if (!base) return undefined;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new ConfigurationError('CDN_URL must be an absolute https URL');
  }
  if (url.protocol !== 'https:') throw new ConfigurationError('CDN_URL must use https');
  const keyPairId = env.CLOUDFRONT_KEY_PAIR_ID?.trim();
  const rawKey =
    env.CLOUDFRONT_PRIVATE_KEY?.trim() ||
    (env.CLOUDFRONT_PRIVATE_KEY_BASE64?.trim()
      ? Buffer.from(env.CLOUDFRONT_PRIVATE_KEY_BASE64.trim(), 'base64').toString('utf8')
      : '');
  // A PEM pasted into one env line usually carries literal "\n" sequences.
  const privateKey = rawKey.replace(/\\n/g, '\n');
  if (!keyPairId || !privateKey.includes('PRIVATE KEY')) {
    throw new ConfigurationError(
      'CDN_URL is set but CLOUDFRONT_KEY_PAIR_ID / CLOUDFRONT_PRIVATE_KEY(_BASE64) are missing or invalid',
    );
  }
  const bucket = env.CDN_BUCKET?.trim() || env.S3_BUCKET_RENDERS?.trim();
  if (!bucket) throw new ConfigurationError('CDN_URL needs CDN_BUCKET (or S3_BUCKET_RENDERS)');
  return { baseUrl: url.origin + url.pathname.replace(/\/+$/, ''), bucket, keyPairId, privateKey };
}

/** The object's CloudFront URL, signed to expire after `expiresInSec`. */
export function cloudFrontSignedUrl(
  cdn: CdnSigningConfig,
  key: string,
  expiresInSec: number,
  nowMs: number,
): string {
  const path = key.split('/').map(encodeURIComponent).join('/');
  return getCloudFrontSignedUrl({
    url: `${cdn.baseUrl}/${path}`,
    keyPairId: cdn.keyPairId,
    privateKey: cdn.privateKey,
    dateLessThan: new Date(nowMs + expiresInSec * 1000),
  });
}

export function createS3Storage(
  client: S3Client,
  options: { cdn?: CdnSigningConfig; now?: () => number } = {},
): AssetStorage {
  const now = options.now ?? Date.now;
  async function signedUrl(bucket: string, key: string, expiresInSec = SIGNED_URL_TTL_SEC) {
    if (options.cdn && bucket === options.cdn.bucket) {
      return cloudFrontSignedUrl(options.cdn, key, expiresInSec, now());
    }
    return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: expiresInSec,
    });
  }
  return {
    async put({ bucket, key, body, contentType }) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          Tagging: objectTaggingFor(key),
        }),
      );
      return { bucket, key, url: await signedUrl(bucket, key) };
    },
    signedUrl,
    async size(bucket, key) {
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      if (head.ContentLength === undefined)
        throw new ValidationError(`No size for s3://${bucket}/${key}`);
      return head.ContentLength;
    },
    async readRange(bucket, key, start, endInclusive) {
      const out = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${start}-${endInclusive}` }),
      );
      if (!out.Body) throw new ValidationError(`Empty range read for s3://${bucket}/${key}`);
      const bytes = await out.Body.transformToByteArray();
      if (bytes.byteLength !== endInclusive - start + 1) {
        throw new ValidationError(
          `Short range read (${bytes.byteLength} bytes) for s3://${bucket}/${key}`,
        );
      }
      return bytes;
    },
    async delete(bucket, key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    putStream: (input) => s3PutStream(client, input),
    copy: (bucket, fromKey, toKey) => s3Copy(client, bucket, fromKey, toKey),
    list: (bucket, prefix, continuationToken) => s3List(client, bucket, prefix, continuationToken),
    deleteMany: (bucket, keys) => s3DeleteMany(client, bucket, keys),
  };
}

// BACKLOG 14.1 — listing and batch deletion for the organisation hard delete.
// ListObjectsV2 (Prefix, ContinuationToken; at most 1,000 keys per page, IsTruncated +
// NextContinuationToken): https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html
// DeleteObjects (at most 1,000 keys; Quiet mode returns only the keys that failed):
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html
// On a versioned bucket a delete without a version id adds a delete marker; the older bytes are
// removed by the noncurrent-version lifecycle rule (infra/s3-lifecycle.json, 14.2).

async function s3List(
  client: S3Client,
  bucket: string,
  prefix: string,
  continuationToken?: string,
): Promise<ListedPage> {
  if (!prefix) throw new ValidationError('Refusing to list a whole bucket: prefix is required');
  const out = await client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: MAX_KEYS_PER_REQUEST,
    }),
  );
  const objects = (out.Contents ?? []).flatMap((o) =>
    o.Key ? [{ key: o.Key, size: o.Size ?? 0 }] : [],
  );
  return { objects, nextToken: out.IsTruncated ? out.NextContinuationToken : undefined };
}

async function s3DeleteMany(
  client: S3Client,
  bucket: string,
  keys: string[],
): Promise<DeleteManyResult> {
  if (keys.length === 0) return { deleted: 0, errors: [] };
  if (keys.length > MAX_KEYS_PER_REQUEST) {
    throw new ValidationError(`DeleteObjects takes at most ${MAX_KEYS_PER_REQUEST} keys`);
  }
  const out = await client.send(
    new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
    }),
  );
  const errors = (out.Errors ?? []).map((e) => ({
    key: e.Key ?? '',
    code: e.Code ?? 'Unknown',
    message: e.Message ?? '',
  }));
  return { deleted: keys.length - errors.length, errors };
}

let defaultStorage: AssetStorage | undefined;

/** S3 storage configured from AWS_REGION + standard AWS credential resolution. */
export function getAssetStorage(): AssetStorage {
  defaultStorage ??= createS3Storage(new S3Client({ region: requireEnv('AWS_REGION') }), {
    cdn: cdnConfigFromEnv(),
  });
  return defaultStorage;
}

export function assetsBucket(): string {
  return requireEnv('S3_BUCKET_ASSETS');
}
