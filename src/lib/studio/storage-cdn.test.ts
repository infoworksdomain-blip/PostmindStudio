import { createVerify, generateKeyPairSync } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { cdnConfigFromEnv, cloudFrontSignedUrl, createS3Storage } from './storage';

// BACKLOG 13.30 — CloudFront signed URLs behind AssetStorage.signedUrl. Canned-policy URLs carry
// Expires, Signature and Key-Pair-Id; the signature is RSA-SHA1 over the canned policy JSON
// (docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-creating-signed-url-canned-policy.html).

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const NOW = Date.parse('2026-09-27T12:00:00Z');
const cdn = {
  baseUrl: 'https://d111.cloudfront.net',
  bucket: 'studio-renders',
  keyPairId: 'K2JCJMDEHXQW5F',
  privateKey,
};

/** CloudFront's URL-safe base64 (+ → -, = → _, / → ~). */
function fromCloudFrontBase64(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'), 'base64');
}

describe('cloudFrontSignedUrl', () => {
  it('signs a canned policy for the object URL with the requested expiry', () => {
    const signed = new URL(cloudFrontSignedUrl(cdn, 'orgs/o 1/renders/a.mp4', 3600, NOW));
    expect(signed.origin + signed.pathname).toBe(
      'https://d111.cloudfront.net/orgs/o%201/renders/a.mp4',
    );
    const expires = signed.searchParams.get('Expires');
    expect(expires).toBe(String(NOW / 1000 + 3600));
    expect(signed.searchParams.get('Key-Pair-Id')).toBe('K2JCJMDEHXQW5F');
    const policy = JSON.stringify({
      Statement: [
        {
          Resource: 'https://d111.cloudfront.net/orgs/o%201/renders/a.mp4',
          Condition: { DateLessThan: { 'AWS:EpochTime': Number(expires) } },
        },
      ],
    });
    const verifier = createVerify('RSA-SHA1');
    verifier.update(policy);
    expect(
      verifier.verify(publicKey, fromCloudFrontBase64(signed.searchParams.get('Signature') ?? '')),
    ).toBe(true);
  });
});

describe('createS3Storage with a CDN', () => {
  const client = new S3Client({
    region: 'eu-west-2',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
  });

  it('uses CloudFront for the CDN bucket and S3 presigning for the others', async () => {
    const storage = createS3Storage(client, { cdn, now: () => NOW });
    const viaCdn = await storage.signedUrl('studio-renders', 'orgs/o/a.mp4', 600);
    expect(viaCdn).toMatch(/^https:\/\/d111\.cloudfront\.net\/orgs\/o\/a\.mp4\?Expires=/);
    const viaS3 = await storage.signedUrl('studio-assets', 'orgs/o/b.png');
    expect(viaS3).toContain('studio-assets');
    expect(viaS3).toContain('X-Amz-Signature=');
  });

  it('falls back to S3 presigned URLs without a CDN', async () => {
    const storage = createS3Storage(client);
    expect(await storage.signedUrl('studio-renders', 'k.mp4')).toContain('X-Amz-Signature=');
  });
});

describe('cdnConfigFromEnv', () => {
  const env = {
    CDN_URL: 'https://d111.cloudfront.net/',
    CLOUDFRONT_KEY_PAIR_ID: 'K2JCJMDEHXQW5F',
    CLOUDFRONT_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n'),
    S3_BUCKET_RENDERS: 'studio-renders',
  };

  it('is off when CDN_URL is unset', () => {
    expect(cdnConfigFromEnv({})).toBeUndefined();
    expect(cdnConfigFromEnv({ CDN_URL: '  ' })).toBeUndefined();
  });

  it('reads the key pair (escaped newlines or base64) and defaults to the renders bucket', () => {
    expect(cdnConfigFromEnv(env)).toEqual({ ...cdn, baseUrl: 'https://d111.cloudfront.net' });
    const b64 = cdnConfigFromEnv({
      ...env,
      CLOUDFRONT_PRIVATE_KEY: undefined,
      CLOUDFRONT_PRIVATE_KEY_BASE64: Buffer.from(privateKey).toString('base64'),
      CDN_BUCKET: 'studio-thumbnails',
    });
    expect(b64?.privateKey).toBe(privateKey);
    expect(b64?.bucket).toBe('studio-thumbnails');
  });

  it('refuses a CDN_URL without https, a key pair, or a bucket', () => {
    expect(() => cdnConfigFromEnv({ ...env, CDN_URL: 'http://cdn.example' })).toThrow('https');
    expect(() => cdnConfigFromEnv({ ...env, CDN_URL: 'not a url' })).toThrow('absolute');
    expect(() => cdnConfigFromEnv({ ...env, CLOUDFRONT_KEY_PAIR_ID: '' })).toThrow(
      'CLOUDFRONT_KEY_PAIR_ID',
    );
    expect(() => cdnConfigFromEnv({ ...env, CLOUDFRONT_PRIVATE_KEY: 'nope' })).toThrow(
      'CLOUDFRONT_KEY_PAIR_ID',
    );
    expect(() => cdnConfigFromEnv({ ...env, S3_BUCKET_RENDERS: undefined })).toThrow('CDN_BUCKET');
  });
});
