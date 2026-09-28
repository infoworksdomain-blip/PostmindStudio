import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationError } from '../errors';
import {
  cdnConfigFromEnv,
  createS3Storage,
  INTERMEDIATES_PREFIX,
  providerOutputKey,
  storageOptionsFor,
} from './storage';
import { createStorageS3Client } from './storage-client';
import { failoverConfigFromEnv } from './storage-failover';

// Storage: Cloudflare R2 — key layout, no object tagging, presigned expiry cap, CDN guard and the
// failover config shape on R2; S3 behaviour pinned alongside so it cannot drift.

afterEach(() => vi.unstubAllEnvs());

const R2_ENV = {
  STORAGE_PROVIDER: 'r2',
  R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  R2_JURISDICTION: 'eu',
  R2_ACCESS_KEY_ID: 'r2-test-key-id',
  R2_SECRET_ACCESS_KEY: 'r2-test-secret',
};
const KEY_INPUT = {
  organisationId: 'o',
  projectId: 'p',
  providerId: 'openai',
  extension: 'png',
  id: 'x',
};

const s3Client = () =>
  new S3Client({
    region: 'eu-west-2',
    credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret' },
  });

describe('providerOutputKey layout per provider', () => {
  it('S3 keeps orgs/<org>/projects/<p>/providers/... byte for byte', () => {
    expect(providerOutputKey(KEY_INPUT, 's3')).toBe('orgs/o/projects/p/providers/openai/x.png');
  });

  it('R2 puts provider outputs under intermediates/orgs/<org>/...', () => {
    expect(providerOutputKey(KEY_INPUT, 'r2')).toBe(
      'intermediates/orgs/o/projects/p/providers/openai/x.png',
    );
    expect(providerOutputKey(KEY_INPUT, 'r2').startsWith(INTERMEDIATES_PREFIX)).toBe(true);
  });

  it('follows STORAGE_PROVIDER by default (s3 when unset)', () => {
    vi.stubEnv('STORAGE_PROVIDER', '');
    expect(providerOutputKey(KEY_INPUT)).toBe('orgs/o/projects/p/providers/openai/x.png');
    vi.stubEnv('STORAGE_PROVIDER', 'r2');
    expect(providerOutputKey(KEY_INPUT)).toBe(
      'intermediates/orgs/o/projects/p/providers/openai/x.png',
    );
    vi.stubEnv('STORAGE_PROVIDER', 'minio');
    expect(() => providerOutputKey(KEY_INPUT)).toThrow(ConfigurationError);
  });
});

describe('object tagging', () => {
  const putProviderOutput = async (client: S3Client, provider: 's3' | 'r2') => {
    const send = vi.spyOn(client, 'send').mockResolvedValue({} as never);
    await createS3Storage(client, storageOptionsFor(provider)).put({
      bucket: 'assets',
      key: providerOutputKey(KEY_INPUT, provider),
      body: new Uint8Array([1]),
      contentType: 'image/png',
    });
    return (send.mock.calls[0]?.[0] as PutObjectCommand).input;
  };

  it('S3 still tags provider outputs studio-object=provider-output', async () => {
    expect((await putProviderOutput(s3Client(), 's3')).Tagging).toBe(
      'studio-object=provider-output',
    );
  });

  it('R2 never sends Tagging, even for a legacy orgs/.../providers/ key', async () => {
    const client = createStorageS3Client(R2_ENV);
    expect((await putProviderOutput(client, 'r2')).Tagging).toBeUndefined();
    const send = vi.spyOn(client, 'send').mockResolvedValue({} as never);
    await createS3Storage(client, storageOptionsFor('r2')).put({
      bucket: 'assets',
      key: 'orgs/o/projects/p/providers/openai/legacy.png',
      body: new Uint8Array([1]),
      contentType: 'image/png',
    });
    expect((send.mock.calls.at(-1)?.[0] as PutObjectCommand).input.Tagging).toBeUndefined();
  });
});

describe('presigned URL expiry', () => {
  const expiresOf = (url: string) => new URL(url).searchParams.get('X-Amz-Expires');

  it('R2 caps the expiry at 604,800 s (7 days)', async () => {
    const storage = createS3Storage(createStorageS3Client(R2_ENV), storageOptionsFor('r2'));
    expect(expiresOf(await storage.signedUrl('b', 'k', 30 * 24 * 60 * 60))).toBe('604800');
    expect(expiresOf(await storage.signedUrl('b', 'k', 3600))).toBe('3600');
    expect(expiresOf(await storage.signedUrl('b', 'k'))).toBe('86400');
    const url = new URL(await storage.signedUrl('b', 'k'));
    expect(url.host).toBe(`${R2_ENV.R2_ACCOUNT_ID}.eu.r2.cloudflarestorage.com`);
  });

  it('S3 is not capped by Studio (the SDK refuses more than 7 days itself)', async () => {
    const storage = createS3Storage(s3Client(), storageOptionsFor('s3'));
    await expect(storage.signedUrl('b', 'k', 30 * 24 * 60 * 60)).rejects.toThrow(/one week/);
    expect(storageOptionsFor('s3')).toEqual({});
  });
});

describe('cdnConfigFromEnv on R2', () => {
  it('refuses CDN_URL with STORAGE_PROVIDER=r2', () => {
    expect(() => cdnConfigFromEnv({ ...R2_ENV, CDN_URL: 'https://d111.cloudfront.net' })).toThrow(
      new ConfigurationError(
        'CloudFront signed URLs need STORAGE_PROVIDER=s3; on R2 leave CDN_URL empty to use presigned R2 URLs',
      ),
    );
  });

  it('is off on R2 without CDN_URL (plain R2 presigned URLs)', () => {
    expect(cdnConfigFromEnv({ ...R2_ENV, CDN_URL: '' })).toBeUndefined();
  });
});

describe('failoverConfigFromEnv on R2 (same config shape, second R2 bucket)', () => {
  const base = { ...R2_ENV, AWS_REGION: 'eu-west-2', S3_BUCKET_ASSETS: 'assets' };

  it('accepts auto or a jurisdiction as S3_FALLBACK_REGION', () => {
    for (const region of ['auto', 'eu', 'us', 'fedramp']) {
      const cfg = failoverConfigFromEnv({
        ...base,
        S3_FALLBACK_REGION: region,
        S3_FALLBACK_BUCKET_ASSETS: 'assets-dr',
      });
      expect(cfg).toEqual({ region, buckets: new Map([['assets', 'assets-dr']]) });
    }
  });

  it('refuses an AWS region name and still requires distinct mapped buckets', () => {
    expect(() =>
      failoverConfigFromEnv({
        ...base,
        S3_FALLBACK_REGION: 'eu-west-1',
        S3_FALLBACK_BUCKET_ASSETS: 'x',
      }),
    ).toThrow(/must be "auto" or one of eu, us, fedramp/);
    expect(() =>
      failoverConfigFromEnv({
        ...base,
        S3_FALLBACK_REGION: 'auto',
        S3_FALLBACK_BUCKET_ASSETS: 'assets',
      }),
    ).toThrow(ConfigurationError);
  });
});
