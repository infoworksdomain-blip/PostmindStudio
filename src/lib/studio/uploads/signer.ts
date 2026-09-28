import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requireEnv } from '../../env';
import { createFfmpegInspector, type MediaInspector } from '../pipeline/media-probe';
import { getAssetStorage, type AssetStorage } from '../storage';
import {
  createPresignS3Client,
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
// Both providers (Storage: Cloudflare R2, 2026-09-28; S3 since Phase 17.6):
//   - the installed presigner (3.1141) puts content-type in its unsignable set unless it is listed
//     in signableHeaders ("Get Presigned URL with headers that should be signed",
//     https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-s3-request-presigner/),
//     so the signer passes signableHeaders {content-type}: the URL signs content-type;host and the
//     store refuses a PUT with another type (403 SignatureDoesNotMatch). R2 documents the same:
//     https://developers.cloudflare.com/r2/api/s3/presigned-urls/ ("Restricting Content-Type").
//     The browser already sends the returned headers ({ 'content-type': <declared type> }), and the
//     bucket CORS rule already allows Content-Type (runbooks/deploy.md, r2-setup.md).
//   - the signing client uses requestChecksumCalculation WHEN_REQUIRED (storage-client.ts
//     createPresignS3Client), so the URL carries no x-amz-checksum-crc32=AAAAAA== /
//     x-amz-sdk-checksum-algorithm (the CRC32 of an EMPTY body the SDK default adds). R2 does not
//     implement it for a single PUT (https://developers.cloudflare.com/r2/api/s3/api/#checksum-types);
//     S3 ignores it today and would reject every upload with BadDigest if it enforced it
//     (PRESIGN_PUT_CHECKSUM_CONFIG explains the evidence).
//   - R2 caps the expiry at 7 days (604,800 s), its maximum; on S3 the SDK enforces SigV4's limit.

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
  /** Sign the Content-Type header (both providers via uploadSignerOptionsFor). */
  signContentType?: boolean;
  /** Cap for the URL expiry (R2: 604,800 s). */
  maxExpiresSec?: number;
}

/** Signer options for a storage provider: both sign Content-Type; R2 also caps the expiry. */
export function uploadSignerOptionsFor(provider: StorageProvider): UploadSignerOptions {
  const maxExpiresSec = maxPresignSecFor(provider);
  return { signContentType: true, ...(maxExpiresSec !== undefined && { maxExpiresSec }) };
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

/** Production wiring: STORAGE_PROVIDER's signing client + S3_BUCKET_ASSETS, system ffprobe. */
export function uploadDepsFromEnv(): UploadDeps {
  fromEnv ??= {
    signer: createS3UploadSigner(
      createPresignS3Client(),
      uploadSignerOptionsFor(storageProvider()),
    ),
    media: createFfmpegInspector(),
    storage: getAssetStorage(),
    bucket: requireEnv('S3_BUCKET_ASSETS'),
  };
  return fromEnv;
}
