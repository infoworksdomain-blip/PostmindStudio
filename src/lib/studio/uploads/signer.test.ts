import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { createStorageS3Client } from '../storage-client';
import { createS3UploadSigner, uploadSignerOptionsFor } from './signer';

// Phase 13.5 presigned PUT + Storage: Cloudflare R2. Presigning is local (no network); static
// test credentials only. The S3 case pins today's URL shape so the R2 work cannot change it.

const R2_ENV = {
  STORAGE_PROVIDER: 'r2',
  R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  R2_JURISDICTION: 'eu',
  R2_ACCESS_KEY_ID: 'r2-test-key-id',
  R2_SECRET_ACCESS_KEY: 'r2-test-secret',
};
const INPUT = {
  bucket: 'studio-assets',
  key: 'orgs/o/uploads/u/source.mp4',
  contentType: 'video/mp4',
  expiresInSec: 900,
};

describe('createS3UploadSigner', () => {
  it('S3: unchanged URL (SDK defaults: host-only signature, SDK checksum params)', async () => {
    const client = new S3Client({
      region: 'eu-west-2',
      credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret' },
    });
    const url = new URL(
      await createS3UploadSigner(client, uploadSignerOptionsFor('s3')).presignPut(INPUT),
    );
    expect(url.host).toBe('studio-assets.s3.eu-west-2.amazonaws.com');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('x-amz-sdk-checksum-algorithm')).toBe('CRC32');
    expect(uploadSignerOptionsFor('s3')).toEqual({});
  });

  it('R2: signs content-type, sends no checksum params, uses the jurisdiction endpoint', async () => {
    const signer = createS3UploadSigner(
      createStorageS3Client(R2_ENV),
      uploadSignerOptionsFor('r2'),
    );
    const url = new URL(await signer.presignPut(INPUT));
    // Virtual-hosted style, as in Cloudflare's own presigned URL examples
    // (https://<bucket>.<ACCOUNT_ID>.r2.cloudflarestorage.com/<key>).
    expect(url.host).toBe(`studio-assets.${R2_ENV.R2_ACCOUNT_ID}.eu.r2.cloudflarestorage.com`);
    expect(url.pathname).toBe('/orgs/o/uploads/u/source.mp4');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
    expect(url.searchParams.has('x-amz-checksum-crc32')).toBe(false);
    expect(url.searchParams.has('x-amz-sdk-checksum-algorithm')).toBe(false);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
  });

  it('R2: caps the expiry at 7 days', async () => {
    const signer = createS3UploadSigner(
      createStorageS3Client(R2_ENV),
      uploadSignerOptionsFor('r2'),
    );
    const url = new URL(await signer.presignPut({ ...INPUT, expiresInSec: 10 * 24 * 60 * 60 }));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('604800');
  });
});
