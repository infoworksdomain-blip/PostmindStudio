import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requireEnv } from '../../env';
import { createFfmpegInspector, type MediaInspector } from '../pipeline/media-probe';
import { getAssetStorage, type AssetStorage } from '../storage';
import {
  createStorageS3Client,
  maxPresignSecFor,
  storageProvider,
  type StorageProvider,
} from '../storage-client';

// Phase 13.5 — presigned S3 PUT for browser uploads. The URL signs Content-Type, so the browser
// must send exactly the declared type; size is enforced on /complete (HEAD the object) because a
// presigned PUT cannot cap the body. AWS: "Uploading objects with presigned URLs"
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html and
// getSignedUrl from @aws-sdk/s3-request-presigner (read 2026-09-27).
//
// Storage: Cloudflare R2 (checked 2026-09-28 against the installed SDK, 3.1141):
//   - this SDK's presigner puts content-type in its unsignable set, so on S3 the URL above signs
//     only `host` (X-Amz-SignedHeaders=host) and Content-Type is NOT enforced by the signature
//     (S3 behaviour left as it was; see the R2 report in PROGRESS.md). On R2 the signer passes
//     signableHeaders {content-type}, so the URL signs content-type;host and R2 refuses a PUT with
//     another type (403 SignatureDoesNotMatch) as Cloudflare documents:
//     https://developers.cloudflare.com/r2/api/s3/presigned-urls/ ("Restricting Content-Type").
//     The browser already sends the returned headers ({ 'content-type': <declared type> }).
//   - the R2 client is built with requestChecksumCalculation WHEN_REQUIRED (storage-client.ts),
//     so the URL carries no x-amz-checksum-crc32=AAAAAA== / x-amz-sdk-checksum-algorithm (the
//     CRC32 of an EMPTY body that the SDK default adds, which R2 does not implement for a single
//     PUT: https://developers.cloudflare.com/r2/api/s3/api/#checksum-types).
//   - expiry is capped at 7 days (604,800 s), R2's maximum.

export interface UploadSigner {
  presignPut(input: {
    bucket: string;
    key: string;
    contentType: string;
    expiresInSec: number;
  }): Promise<string>;
}

export interface UploadDeps {
  signer: UploadSigner;
  /** ffprobe for /complete (the same inspector the pipeline uses). */
  media: MediaInspector;
  /** HEAD for the uploaded size, signed GET for ffprobe, delete for rejected files. */
  storage: AssetStorage;
  /** Bucket uploads land in (S3_BUCKET_ASSETS). */
  bucket: string;
}

export interface UploadSignerOptions {
  /** Sign the Content-Type header (R2); default false keeps the S3 URL unchanged. */
  signContentType?: boolean;
  /** Cap for the URL expiry (R2: 604,800 s). */
  maxExpiresSec?: number;
}

/** Signer options for a storage provider (S3: none, i.e. today's URLs). */
export function uploadSignerOptionsFor(provider: StorageProvider): UploadSignerOptions {
  return provider === 'r2'
    ? { signContentType: true, maxExpiresSec: maxPresignSecFor(provider) }
    : {};
}

export function createS3UploadSigner(
  client: S3Client,
  options: UploadSignerOptions = {},
): UploadSigner {
  return {
    presignPut: ({ bucket, key, contentType, expiresInSec }) =>
      getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
        {
          expiresIn:
            options.maxExpiresSec === undefined
              ? expiresInSec
              : Math.min(expiresInSec, options.maxExpiresSec),
          ...(options.signContentType && { signableHeaders: new Set(['content-type']) }),
        },
      ),
  };
}

let fromEnv: UploadDeps | undefined;

/** Production wiring: STORAGE_PROVIDER's client + S3_BUCKET_ASSETS, system ffprobe. */
export function uploadDepsFromEnv(): UploadDeps {
  fromEnv ??= {
    signer: createS3UploadSigner(
      createStorageS3Client(),
      uploadSignerOptionsFor(storageProvider()),
    ),
    media: createFfmpegInspector(),
    storage: getAssetStorage(),
    bucket: requireEnv('S3_BUCKET_ASSETS'),
  };
  return fromEnv;
}
