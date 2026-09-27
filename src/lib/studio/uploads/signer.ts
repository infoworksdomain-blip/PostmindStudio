import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requireEnv } from '../../env';
import { createFfmpegInspector, type MediaInspector } from '../pipeline/media-probe';
import { getAssetStorage, type AssetStorage } from '../storage';

// Phase 13.5 — presigned S3 PUT for browser uploads. The URL signs Content-Type, so the browser
// must send exactly the declared type; size is enforced on /complete (HEAD the object) because a
// presigned PUT cannot cap the body. AWS: "Uploading objects with presigned URLs"
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html and
// getSignedUrl from @aws-sdk/s3-request-presigner (read 2026-09-27).

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

export function createS3UploadSigner(client: S3Client): UploadSigner {
  return {
    presignPut: ({ bucket, key, contentType, expiresInSec }) =>
      getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
        { expiresIn: expiresInSec },
      ),
  };
}

let fromEnv: UploadDeps | undefined;

/** Production wiring: AWS_REGION + S3_BUCKET_ASSETS, system ffprobe. */
export function uploadDepsFromEnv(): UploadDeps {
  fromEnv ??= {
    signer: createS3UploadSigner(new S3Client({ region: requireEnv('AWS_REGION') })),
    media: createFfmpegInspector(),
    storage: getAssetStorage(),
    bucket: requireEnv('S3_BUCKET_ASSETS'),
  };
  return fromEnv;
}
