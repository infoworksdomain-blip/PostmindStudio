import { randomUUID } from 'node:crypto';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requireEnv } from '../env';
import { ValidationError } from '../errors';

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

export function createS3Storage(client: S3Client): AssetStorage {
  async function signedUrl(bucket: string, key: string, expiresInSec = SIGNED_URL_TTL_SEC) {
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
  };
}

let defaultStorage: AssetStorage | undefined;

/** S3 storage configured from AWS_REGION + standard AWS credential resolution. */
export function getAssetStorage(): AssetStorage {
  defaultStorage ??= createS3Storage(new S3Client({ region: requireEnv('AWS_REGION') }));
  return defaultStorage;
}

export function assetsBucket(): string {
  return requireEnv('S3_BUCKET_ASSETS');
}
