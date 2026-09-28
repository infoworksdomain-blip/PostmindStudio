import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../errors';
import {
  createStorageS3Client,
  INTERMEDIATES_PREFIX,
  maxPresignSecFor,
  R2_CHECKSUM_CONFIG,
  R2_MAX_PRESIGN_SEC,
  r2Endpoint,
  storageClientConfig,
  storageConfigFromEnv,
  storageProvider,
  storageRequiredEnv,
} from './storage-client';

// Storage: Cloudflare R2 — the object-storage client factory (STORAGE_PROVIDER=s3|r2).
// Static test credentials only; presigning is local (no network).

const R2_ENV = {
  STORAGE_PROVIDER: 'r2',
  R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  R2_ACCESS_KEY_ID: 'r2-test-key-id',
  R2_SECRET_ACCESS_KEY: 'r2-test-secret',
};

describe('storageProvider', () => {
  it('defaults to s3 (unset or blank) and accepts s3 | r2', () => {
    expect(storageProvider({})).toBe('s3');
    expect(storageProvider({ STORAGE_PROVIDER: '  ' })).toBe('s3');
    expect(storageProvider({ STORAGE_PROVIDER: 's3' })).toBe('s3');
    expect(storageProvider({ STORAGE_PROVIDER: ' r2 ' })).toBe('r2');
  });

  it('fails fast on anything else', () => {
    for (const bad of ['R2', 'gcs', 'aws']) {
      expect(() => storageProvider({ STORAGE_PROVIDER: bad })).toThrow(ConfigurationError);
    }
    expect(() => storageProvider({ STORAGE_PROVIDER: 'gcs' })).toThrow(/must be "s3" or "r2"/);
  });
});

describe('storageConfigFromEnv', () => {
  it('s3: needs AWS_REGION, with the same message requireEnv gave', () => {
    expect(storageConfigFromEnv({ AWS_REGION: 'eu-west-2' })).toEqual({
      provider: 's3',
      region: 'eu-west-2',
    });
    expect(() => storageConfigFromEnv({})).toThrow(
      'Missing required environment variable AWS_REGION',
    );
  });

  it('r2: account id, keys and an optional jurisdiction (AWS_REGION not needed)', () => {
    expect(storageConfigFromEnv(R2_ENV)).toEqual({
      provider: 'r2',
      accountId: R2_ENV.R2_ACCOUNT_ID,
      accessKeyId: 'r2-test-key-id',
      secretAccessKey: 'r2-test-secret',
    });
    expect(storageConfigFromEnv({ ...R2_ENV, R2_JURISDICTION: 'eu' })).toMatchObject({
      jurisdiction: 'eu',
    });
    expect(storageConfigFromEnv({ ...R2_ENV, R2_JURISDICTION: '' })).not.toHaveProperty(
      'jurisdiction',
    );
  });

  it('r2: names every missing or invalid variable', () => {
    let error: unknown;
    try {
      storageConfigFromEnv({ STORAGE_PROVIDER: 'r2', R2_JURISDICTION: 'apac' });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigurationError);
    const message = (error as Error).message;
    expect(message).toMatch(/R2_ACCOUNT_ID is required when STORAGE_PROVIDER=r2/);
    expect(message).toMatch(/R2_ACCESS_KEY_ID is required/);
    expect(message).toMatch(/R2_SECRET_ACCESS_KEY is required/);
    expect(message).toMatch(/R2_JURISDICTION must be one of eu, us, fedramp/);
  });

  it('r2: refuses an account id that could change the endpoint host', () => {
    for (const bad of ['acct.evil.com', 'acct/x', 'user@acct', 'acct:443']) {
      expect(() => storageConfigFromEnv({ ...R2_ENV, R2_ACCOUNT_ID: bad })).toThrow(
        /R2_ACCOUNT_ID must be the Cloudflare account id/,
      );
    }
  });
});

describe('r2Endpoint', () => {
  it('uses the account endpoint, or the jurisdiction endpoint for jurisdiction buckets', () => {
    expect(r2Endpoint('acct')).toBe('https://acct.r2.cloudflarestorage.com');
    expect(r2Endpoint('acct', 'eu')).toBe('https://acct.eu.r2.cloudflarestorage.com');
    expect(r2Endpoint('acct', 'fedramp')).toBe('https://acct.fedramp.r2.cloudflarestorage.com');
    expect(r2Endpoint('acct', 'us')).toBe('https://acct.us.r2.cloudflarestorage.com');
    expect(() => r2Endpoint('a.b')).toThrow(ConfigurationError);
  });
});

describe('storageClientConfig', () => {
  it('s3: exactly { region } (the client Studio always built), fallback region on request', () => {
    const s3 = { provider: 's3' as const, region: 'eu-west-2' };
    expect(storageClientConfig(s3)).toEqual({ region: 'eu-west-2' });
    expect(storageClientConfig(s3, { fallbackRegion: 'eu-west-1' })).toEqual({
      region: 'eu-west-1',
    });
  });

  it('r2: region auto, the R2 endpoint, the R2 keys and WHEN_REQUIRED checksums', () => {
    const r2 = storageConfigFromEnv({ ...R2_ENV, R2_JURISDICTION: 'eu' });
    expect(storageClientConfig(r2)).toEqual({
      region: 'auto',
      endpoint: `https://${R2_ENV.R2_ACCOUNT_ID}.eu.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: 'r2-test-key-id', secretAccessKey: 'r2-test-secret' },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    expect(R2_CHECKSUM_CONFIG.requestChecksumCalculation).toBe('WHEN_REQUIRED');
  });

  it('r2 failover: auto keeps the endpoint, a jurisdiction switches it, anything else fails', () => {
    const r2 = storageConfigFromEnv({ ...R2_ENV, R2_JURISDICTION: 'eu' });
    expect(storageClientConfig(r2, { fallbackRegion: 'auto' }).endpoint).toBe(
      `https://${R2_ENV.R2_ACCOUNT_ID}.eu.r2.cloudflarestorage.com`,
    );
    expect(storageClientConfig(r2, { fallbackRegion: 'us' }).endpoint).toBe(
      `https://${R2_ENV.R2_ACCOUNT_ID}.us.r2.cloudflarestorage.com`,
    );
    expect(() => storageClientConfig(r2, { fallbackRegion: 'eu-west-1' })).toThrow(
      ConfigurationError,
    );
  });
});

describe('createStorageS3Client', () => {
  it('s3: presigned URLs are AWS URLs in AWS_REGION', async () => {
    const client = createStorageS3Client({ AWS_REGION: 'eu-west-2' });
    expect(await client.config.region()).toBe('eu-west-2');
  });

  it('r2: signs against the jurisdiction endpoint in region auto, with no checksum params', async () => {
    const client = createStorageS3Client({ ...R2_ENV, R2_JURISDICTION: 'eu' });
    const get = new URL(
      await getSignedUrl(client, new GetObjectCommand({ Bucket: 'b', Key: 'k.mp4' }), {
        expiresIn: 60,
      }),
    );
    expect(get.host).toBe(`${R2_ENV.R2_ACCOUNT_ID}.eu.r2.cloudflarestorage.com`);
    expect(get.searchParams.get('X-Amz-Credential')).toMatch(/^r2-test-key-id\/\d{8}\/auto\/s3\//);
    expect(get.searchParams.has('x-amz-checksum-mode')).toBe(false);
    const put = new URL(
      await getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: 'b', Key: 'k.mp4', ContentType: 'video/mp4' }),
        { expiresIn: 60 },
      ),
    );
    expect(put.searchParams.has('x-amz-checksum-crc32')).toBe(false);
    expect(put.searchParams.has('x-amz-sdk-checksum-algorithm')).toBe(false);
  });

  it('fails fast on a bad configuration', () => {
    expect(() => createStorageS3Client({ STORAGE_PROVIDER: 'r2' })).toThrow(ConfigurationError);
    expect(() => createStorageS3Client({})).toThrow(ConfigurationError);
  });
});

describe('limits and helpers', () => {
  it('caps presigned URLs at 7 days on R2 only', () => {
    expect(R2_MAX_PRESIGN_SEC).toBe(604_800);
    expect(maxPresignSecFor('r2')).toBe(604_800);
    expect(maxPresignSecFor('s3')).toBeUndefined();
  });

  it('lists the env the provider needs', () => {
    expect(storageRequiredEnv({})).toEqual(['AWS_REGION']);
    expect(storageRequiredEnv({ STORAGE_PROVIDER: 'r2' })).toEqual([
      'R2_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
    ]);
  });

  it('keeps provider outputs under a dedicated top-level prefix on R2', () => {
    expect(INTERMEDIATES_PREFIX).toBe('intermediates/');
  });
});
