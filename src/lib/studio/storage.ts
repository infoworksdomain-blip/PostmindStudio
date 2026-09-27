import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requireEnv } from '../env';

// Object storage for provider outputs that arrive as bytes (OpenAI GPT image models return
// base64 only; ElevenLabs returns raw audio). Buckets per CLAUDE.md: studio-assets,
// studio-renders, studio-thumbnails, studio-library-assets.

export const SIGNED_URL_TTL_SEC = 24 * 60 * 60;

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
