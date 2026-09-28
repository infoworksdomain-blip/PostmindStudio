import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPresignS3Client, createStorageS3Client } from '../storage-client';
import { createS3UploadSigner, uploadSignerOptionsFor } from './signer';

// Phase 13.5 presigned PUT + Storage: Cloudflare R2 + Phase 17.6 (S3 signs Content-Type and drops
// the empty-body checksum). Presigning is local (no network); static test credentials only.

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
  describe('S3', () => {
    beforeEach(() => {
      vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDTEST');
      vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test-secret');
    });
    afterEach(() => vi.unstubAllEnvs());

    it('signs content-type and sends no checksum params (17.6)', async () => {
      const signer = createS3UploadSigner(
        createPresignS3Client({ AWS_REGION: 'eu-west-2' }),
        uploadSignerOptionsFor('s3'),
      );
      const url = new URL(await signer.presignPut(INPUT));
      expect(url.host).toBe('studio-assets.s3.eu-west-2.amazonaws.com');
      expect(url.pathname).toBe('/orgs/o/uploads/u/source.mp4');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
      expect(url.searchParams.has('x-amz-checksum-crc32')).toBe(false);
      expect(url.searchParams.has('x-amz-sdk-checksum-algorithm')).toBe(false);
      expect(uploadSignerOptionsFor('s3')).toEqual({ signContentType: true });
    });

    it('a client with the SDK defaults would add the empty-body CRC32 (why 17.6 exists)', async () => {
      const client = new S3Client({
        region: 'eu-west-2',
        credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret' },
      });
      const url = new URL(
        await createS3UploadSigner(client, uploadSignerOptionsFor('s3')).presignPut(INPUT),
      );
      expect(url.searchParams.get('x-amz-checksum-crc32')).toBe('AAAAAA==');
      expect(url.searchParams.get('x-amz-sdk-checksum-algorithm')).toBe('CRC32');
    });

    it('the server-side storage client keeps the SDK default checksums', async () => {
      const client = createStorageS3Client({ AWS_REGION: 'eu-west-2' });
      expect(await client.config.requestChecksumCalculation()).toBe('WHEN_SUPPORTED');
      const presign = createPresignS3Client({ AWS_REGION: 'eu-west-2' });
      expect(await presign.config.requestChecksumCalculation()).toBe('WHEN_REQUIRED');
    });
  });

  it('R2: signs content-type, sends no checksum params, uses the jurisdiction endpoint', async () => {
    const signer = createS3UploadSigner(
      createPresignS3Client(R2_ENV),
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
      createPresignS3Client(R2_ENV),
      uploadSignerOptionsFor('r2'),
    );
    const url = new URL(await signer.presignPut({ ...INPUT, expiresInSec: 10 * 24 * 60 * 60 }));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('604800');
  });
});
