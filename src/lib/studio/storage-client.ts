import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { ConfigurationError } from '../errors';

// Storage: Cloudflare R2 — the one place Studio builds the S3 client for OBJECT STORAGE.
// STORAGE_PROVIDER=s3 (default) keeps the exact client Studio always had:
//   new S3Client({ region: AWS_REGION }) + the standard AWS credential chain.
// STORAGE_PROVIDER=r2 points the same AWS SDK v3 client at Cloudflare R2 (read 2026-09-28):
//   - region 'auto', endpoint https://<ACCOUNT_ID>.r2.cloudflarestorage.com, credentials = the
//     Access Key ID + Secret Access Key of an R2 API token
//     https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/
//   - a bucket created with a jurisdiction (eu | fedramp | us) is ONLY reachable through
//     https://<ACCOUNT_ID>.<JURISDICTION>.r2.cloudflarestorage.com, and that endpoint cannot reach
//     buckets outside the jurisdiction https://developers.cloudflare.com/r2/reference/data-location/
//   - request/response checksums WHEN_REQUIRED (see R2_CHECKSUM_CONFIG below).
// Envelope encryption is NOT storage: the KMSClient (crypto/envelope.ts, KMS_KEY_ID) keeps using
// AWS_REGION + the AWS credentials on both providers.

export const STORAGE_PROVIDERS = ['s3', 'r2'] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

/**
 * R2 key prefix for provider outputs ("intermediates", spec 17.4) — see storage.ts
 * providerOutputKey for why the layout depends on the provider.
 */
export const INTERMEDIATES_PREFIX = 'intermediates/';

export const R2_JURISDICTIONS = ['eu', 'us', 'fedramp'] as const;
export type R2Jurisdiction = (typeof R2_JURISDICTIONS)[number];

/**
 * R2 presigned URLs are valid for at most 7 days
 * (https://developers.cloudflare.com/r2/api/s3/presigned-urls/). SigV4 has the same ceiling on
 * S3, where the SDK itself refuses a longer expiry; on R2 Studio caps it instead of failing.
 */
export const R2_MAX_PRESIGN_SEC = 604_800;

/**
 * The installed @aws-sdk/client-s3 (3.1141) defaults to requestChecksumCalculation /
 * responseChecksumValidation 'WHEN_SUPPORTED': every PutObject / UploadPart gets an
 * x-amz-checksum-crc32 header, presigned PUTs get x-amz-checksum-crc32=AAAAAA== (the CRC32 of an
 * EMPTY body) + x-amz-sdk-checksum-algorithm=CRC32 in the query, and presigned GETs get
 * x-amz-checksum-mode=ENABLED (checked locally with getSignedUrl, 2026-09-28). The SDK change is
 * https://github.com/aws/aws-sdk-js-v3/issues/6810; R2 answered it with "501 NotImplemented:
 * Header 'x-amz-checksum-crc32' ... not implemented" on PutObject/UploadPart
 * (https://community.cloudflare.com/t/aws-sdk-client-s3-v3-729-0-breaks-uploadpart-and-putobject-r2-s3-api-compatibility/758637),
 * and R2's compatibility table still lists CRC32 as COMPOSITE-only (no FULL_OBJECT CRC32, which a
 * single PutObject is) https://developers.cloudflare.com/r2/api/s3/api/#checksum-types.
 * WHEN_REQUIRED sends a checksum only where the S3 model requires one (DeleteObjects,
 * PutBucketLifecycleConfiguration still send CRC32 — verify those on staging, runbooks/r2-setup.md).
 * S3 keeps the SDK default: its behaviour must not change.
 */
export const R2_CHECKSUM_CONFIG = {
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
} as const satisfies Pick<
  S3ClientConfig,
  'requestChecksumCalculation' | 'responseChecksumValidation'
>;

type Env = Record<string, string | undefined>;

/** Empty or whitespace-only env values count as unset (same rule as requireEnv); others trimmed. */
const blankToUndefined = (v: unknown) =>
  typeof v === 'string' ? (v.trim() === '' ? undefined : v.trim()) : v;

// A hostname label: the account id is interpolated into the endpoint host, so nothing that could
// change the host (dots, slashes, '@', ':') is accepted.
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

const providerSchema = z.preprocess(blankToUndefined, z.enum(STORAGE_PROVIDERS).default('s3'));

const requiredForR2 = (name: string) =>
  z.preprocess(
    blankToUndefined,
    z.string({ error: `${name} is required when STORAGE_PROVIDER=r2` }),
  );

const r2Schema = z.object({
  R2_ACCOUNT_ID: requiredForR2('R2_ACCOUNT_ID').pipe(
    z
      .string()
      .regex(HOST_LABEL, 'R2_ACCOUNT_ID must be the Cloudflare account id (letters and digits)'),
  ),
  R2_JURISDICTION: z.preprocess(
    blankToUndefined,
    z
      .enum(R2_JURISDICTIONS, {
        error: `R2_JURISDICTION must be one of ${R2_JURISDICTIONS.join(', ')} (or empty for none)`,
      })
      .optional(),
  ),
  R2_ACCESS_KEY_ID: requiredForR2('R2_ACCESS_KEY_ID'),
  R2_SECRET_ACCESS_KEY: requiredForR2('R2_SECRET_ACCESS_KEY'),
});

export interface S3StorageConfig {
  provider: 's3';
  region: string;
}

export interface R2StorageConfig {
  provider: 'r2';
  accountId: string;
  jurisdiction?: R2Jurisdiction;
  accessKeyId: string;
  secretAccessKey: string;
}

export type StorageConfig = S3StorageConfig | R2StorageConfig;

/** STORAGE_PROVIDER (s3 | r2, default s3). Throws ConfigurationError on anything else. */
export function storageProvider(env: Env = process.env): StorageProvider {
  const parsed = providerSchema.safeParse(env.STORAGE_PROVIDER);
  if (!parsed.success) {
    throw new ConfigurationError(
      `STORAGE_PROVIDER must be "s3" or "r2" (got ${JSON.stringify(env.STORAGE_PROVIDER)})`,
    );
  }
  return parsed.data;
}

/** The validated storage settings for the configured provider; fails fast with every problem. */
export function storageConfigFromEnv(env: Env = process.env): StorageConfig {
  const provider = storageProvider(env);
  if (provider === 's3') {
    const region = env.AWS_REGION;
    // Same check and message as requireEnv('AWS_REGION'), which this replaces.
    if (region === undefined || region.trim() === '') {
      throw new ConfigurationError('Missing required environment variable AWS_REGION');
    }
    return { provider, region };
  }
  const parsed = r2Schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigurationError(
      `Invalid Cloudflare R2 storage configuration: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      {
        problems: parsed.error.issues.map((i) => ({
          variable: i.path.join('.'),
          message: i.message,
        })),
      },
    );
  }
  return {
    provider,
    accountId: parsed.data.R2_ACCOUNT_ID,
    ...(parsed.data.R2_JURISDICTION && { jurisdiction: parsed.data.R2_JURISDICTION }),
    accessKeyId: parsed.data.R2_ACCESS_KEY_ID,
    secretAccessKey: parsed.data.R2_SECRET_ACCESS_KEY,
  };
}

/** https://<ACCOUNT_ID>[.<JURISDICTION>].r2.cloudflarestorage.com */
export function r2Endpoint(accountId: string, jurisdiction?: R2Jurisdiction): string {
  if (!HOST_LABEL.test(accountId)) {
    throw new ConfigurationError('R2 account id is not a valid hostname label');
  }
  return `https://${accountId}${jurisdiction ? `.${jurisdiction}` : ''}.r2.cloudflarestorage.com`;
}

export interface ClientTarget {
  /**
   * 15.E9 failover target (S3_FALLBACK_REGION). S3: the fallback AWS region. R2: 'auto' = the
   * primary's endpoint (a second bucket in the same account and jurisdiction), or a jurisdiction
   * (eu | us | fedramp) when the fallback bucket was created in another one.
   */
  fallbackRegion?: string;
}

/** The S3ClientConfig for the provider (exported for tests; use createStorageS3Client). */
export function storageClientConfig(
  config: StorageConfig,
  target: ClientTarget = {},
): S3ClientConfig {
  if (config.provider === 's3') return { region: target.fallbackRegion ?? config.region };
  let jurisdiction = config.jurisdiction;
  if (target.fallbackRegion !== undefined && target.fallbackRegion !== 'auto') {
    if (!(R2_JURISDICTIONS as readonly string[]).includes(target.fallbackRegion)) {
      throw new ConfigurationError(
        `On R2, S3_FALLBACK_REGION must be "auto" or one of ${R2_JURISDICTIONS.join(', ')}`,
      );
    }
    jurisdiction = target.fallbackRegion as R2Jurisdiction;
  }
  return {
    region: 'auto',
    endpoint: r2Endpoint(config.accountId, jurisdiction),
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    ...R2_CHECKSUM_CONFIG,
  };
}

/** The object-storage S3Client for STORAGE_PROVIDER (never used for KMS). */
export function createStorageS3Client(env: Env = process.env, target: ClientTarget = {}): S3Client {
  return new S3Client(storageClientConfig(storageConfigFromEnv(env), target));
}

/** Longest presigned-URL expiry the provider allows, or undefined for "leave it to the SDK". */
export function maxPresignSecFor(provider: StorageProvider): number | undefined {
  return provider === 'r2' ? R2_MAX_PRESIGN_SEC : undefined;
}

/** Env names the configured provider needs for storage access (staging-gate readiness checks). */
export function storageRequiredEnv(env: Env = process.env): string[] {
  return storageProvider(env) === 'r2'
    ? ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']
    : ['AWS_REGION'];
}
