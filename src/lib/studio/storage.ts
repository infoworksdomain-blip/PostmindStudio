import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl as getCloudFrontSignedUrl } from '@aws-sdk/cloudfront-signer';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requireEnv } from '../env';
import { ConfigurationError, ValidationError } from '../errors';
import { logger } from '../logger';
import { createFailoverStorage, failoverConfigFromEnv } from './storage-failover';
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
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
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
  };
}

let defaultStorage: AssetStorage | undefined;

/**
 * S3 storage configured from AWS_REGION + standard AWS credential resolution; with
 * S3_FALLBACK_REGION set, wrapped in the secondary-region failover (15.E9, storage-failover.ts).
 */
export function getAssetStorage(): AssetStorage {
  if (defaultStorage) return defaultStorage;
  const primary = createS3Storage(new S3Client({ region: requireEnv('AWS_REGION') }), {
    cdn: cdnConfigFromEnv(),
  });
  const failover = failoverConfigFromEnv();
  defaultStorage = failover
    ? createFailoverStorage(
        primary,
        createS3Storage(new S3Client({ region: failover.region })),
        failover,
        logger,
      )
    : primary;
  return defaultStorage;
}

export function assetsBucket(): string {
  return requireEnv('S3_BUCKET_ASSETS');
}
