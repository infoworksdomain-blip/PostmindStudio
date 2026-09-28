import type { S3ClientConfig } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { ConfigurationError, ValidationError } from '../../errors';
import { storageClientConfig, storageConfigFromEnv, type StorageConfig } from '../storage-client';

// Phase 17.5 — scheduled backup copy of object storage (runbooks/backup-recovery.md). Pure: the
// configuration, the per-bucket plan (what to copy, what to tombstone, what has aged out) and the
// state file. The I/O is in storage-backup-run.ts; the CLI is scripts/ops/backup-storage.ts.
//
// Why: R2 has no bucket versioning (https://developers.cloudflare.com/r2/api/s3/api/) and S3's
// noncurrent versions only live 30 days (infra/s3-lifecycle.json), so a deleted object is gone
// for good without a copy outside the live buckets.
//
// Layout decision: ONE backup bucket (S3_BACKUP_BUCKET) with a prefix per logical bucket
// (assets/, renders/, thumbnails/), not one backup bucket per primary:
//   - one bucket to create, one token scope and one set of lifecycle rules per environment;
//   - on R2 a token is scoped to a list of buckets, so "the app token cannot touch the backup"
//     stays a one-bucket rule;
//   - the source key is kept after the prefix, so a restore is "copy <logical>/<key> back to
//     <key>" and orgs/<id>/ stays greppable inside the backup.
// The job's state (tombstones) lives in the same bucket under STATE_KEY, outside those prefixes.
//
// Incremental: both buckets are listed (ListObjectsV2 returns Key, Size, ETag, LastModified) and
// an object is copied only when its backup copy is missing or differs: a different size, or the
// ETag differs AND the backup copy is older than the source. The LastModified rule is needed
// because a server-side copy of a multipart object gets a new (non-multipart) ETag on S3
// (https://docs.aws.amazon.com/AmazonS3/latest/API/API_Object.html, ETag). Studio keys are
// write-once (uuid / content-hash names), so "changed" is rare.
//
// Deletes are never propagated at once. The first run that finds a backup copy without its source
// records a tombstone (the time it was first seen missing); once the tombstone is
// S3_BACKUP_RETENTION_DAYS old (default 30, at most 30) the copy is deleted. That bound is what
// keeps an organisation hard delete or a business purge effective: purged data leaves the backup
// at most RETENTION_DAYS + one run interval after the live object was deleted. A source object
// that comes back (restored) clears its tombstone.

export const BACKUP_LOGICAL_BUCKETS = ['assets', 'renders', 'thumbnails', 'library'] as const;
export type BackupLogicalBucket = (typeof BACKUP_LOGICAL_BUCKETS)[number];

/**
 * Backed up by default. The library holds the platform corpus, which can be re-ingested from the
 * corpus manifest (runbooks/backup-recovery.md); add it with --only when wanted.
 */
export const DEFAULT_BACKUP_BUCKETS: readonly BackupLogicalBucket[] = [
  'assets',
  'renders',
  'thumbnails',
];

export const SOURCE_BUCKET_ENV: Record<BackupLogicalBucket, string> = {
  assets: 'S3_BUCKET_ASSETS',
  renders: 'S3_BUCKET_RENDERS',
  thumbnails: 'S3_BUCKET_THUMBNAILS',
  library: 'S3_BUCKET_LIBRARY',
};

/** Where the job keeps its tombstones, inside the backup bucket. */
export const STATE_KEY = '.studio-backup/state.json';
export const DEFAULT_RETENTION_DAYS = 30;
/** The runbooks promise purged data ages out within 30 days: the env may shorten, never extend. */
export const MAX_RETENTION_DAYS = 30;
/**
 * CopyObject and a single PutObject both stop at 5 GiB
 * (https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html; R2: "5 GiB" per PUT,
 * https://developers.cloudflare.com/r2/platform/limits/). Studio's largest object is a data export
 * under 4 GiB (export/zip.ts), so larger objects are reported, not copied.
 */
export const MAX_SINGLE_COPY_BYTES = 5 * 1024 ** 3;
/**
 * Safety valve: a run that would tombstone more than this share of a bucket's backup (and at
 * least MASS_TOMBSTONE_MIN_OBJECTS objects) stops for that bucket. A wrong S3_BUCKET_* or an empty
 * listing must not start the clock on the whole backup. --allow-mass-tombstone overrides it.
 */
export const MASS_TOMBSTONE_RATIO = 0.25;
export const MASS_TOMBSTONE_MIN_OBJECTS = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

type Env = Record<string, string | undefined>;

const blank = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);

export interface BackupSource {
  logical: BackupLogicalBucket;
  bucket: string;
}

export interface BackupConfig {
  backupBucket: string;
  retentionDays: number;
  /** Buckets to back up; a logical bucket whose S3_BUCKET_* is unset is listed in `skipped`. */
  sources: BackupSource[];
  skipped: BackupLogicalBucket[];
  sourceClient: S3ClientConfig;
  backupClient: S3ClientConfig;
  /** Same endpoint and same credentials: CopyObject server-side; otherwise stream GET → PUT. */
  serverSideCopy: boolean;
}

const retentionSchema = z.coerce
  .number({ error: 'S3_BACKUP_RETENTION_DAYS must be a whole number of days' })
  .int('S3_BACKUP_RETENTION_DAYS must be a whole number of days')
  .min(1, 'S3_BACKUP_RETENTION_DAYS must be at least 1')
  .max(
    MAX_RETENTION_DAYS,
    `S3_BACKUP_RETENTION_DAYS must be at most ${MAX_RETENTION_DAYS} (purged data must age out)`,
  );

export function retentionDaysFromEnv(env: Env = process.env): number {
  const raw = blank(env.S3_BACKUP_RETENTION_DAYS);
  if (raw === undefined) return DEFAULT_RETENTION_DAYS;
  const parsed = retentionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigurationError(parsed.error.issues.map((i) => i.message).join('; '));
  }
  return parsed.data;
}

/** The backup job's own key pair, or undefined to use the storage credentials. */
function backupCredentials(env: Env): { accessKeyId: string; secretAccessKey: string } | undefined {
  const accessKeyId = blank(env.S3_BACKUP_ACCESS_KEY_ID);
  const secretAccessKey = blank(env.S3_BACKUP_SECRET_ACCESS_KEY);
  if (!accessKeyId && !secretAccessKey) return undefined;
  if (!accessKeyId || !secretAccessKey) {
    throw new ConfigurationError(
      'Set both S3_BACKUP_ACCESS_KEY_ID and S3_BACKUP_SECRET_ACCESS_KEY, or neither',
    );
  }
  return { accessKeyId, secretAccessKey };
}

function withCredentials(
  storage: StorageConfig,
  credentials: { accessKeyId: string; secretAccessKey: string } | undefined,
  target: { fallbackRegion?: string },
): S3ClientConfig {
  if (storage.provider === 'r2') {
    return storageClientConfig(credentials ? { ...storage, ...credentials } : storage, target);
  }
  const base = storageClientConfig(storage, target);
  return credentials ? { ...base, credentials } : base;
}

/** "Same endpoint": the R2 endpoint URL, or the AWS region for S3. */
export function endpointOf(config: S3ClientConfig): string {
  if (typeof config.endpoint === 'string') return config.endpoint;
  return `aws:${String(config.region)}`;
}

/** Validated backup configuration; throws ConfigurationError with every problem it can see. */
export function backupConfigFromEnv(
  env: Env = process.env,
  only: readonly BackupLogicalBucket[] = DEFAULT_BACKUP_BUCKETS,
): BackupConfig {
  const backupBucket = blank(env.S3_BACKUP_BUCKET);
  if (!backupBucket) {
    throw new ConfigurationError('Missing required environment variable S3_BACKUP_BUCKET');
  }
  const storage = storageConfigFromEnv(env);
  const credentials = backupCredentials(env);
  const region = blank(env.S3_BACKUP_REGION);
  const sourceClient = withCredentials(storage, credentials, {});
  const backupClient = withCredentials(storage, credentials, { fallbackRegion: region });

  const sources: BackupSource[] = [];
  const skipped: BackupLogicalBucket[] = [];
  for (const logical of only) {
    const bucket = blank(env[SOURCE_BUCKET_ENV[logical]]);
    if (bucket) sources.push({ logical, bucket });
    else skipped.push(logical);
  }
  // The backup must never be one of the live buckets (or their failover buckets): the job would
  // copy the bucket into itself and then age its own objects out.
  const live = [
    ...Object.values(SOURCE_BUCKET_ENV),
    'S3_FALLBACK_BUCKET_ASSETS',
    'S3_FALLBACK_BUCKET_RENDERS',
    'S3_FALLBACK_BUCKET_THUMBNAILS',
    'S3_FALLBACK_BUCKET_LIBRARY',
  ].flatMap((name) => (blank(env[name]) === backupBucket ? [name] : []));
  if (live.length) {
    throw new ConfigurationError(
      `S3_BACKUP_BUCKET must be a separate bucket (it equals ${live.join(', ')})`,
    );
  }
  return {
    backupBucket,
    retentionDays: retentionDaysFromEnv(env),
    sources,
    skipped,
    sourceClient,
    backupClient,
    serverSideCopy: endpointOf(sourceClient) === endpointOf(backupClient),
  };
}

// ---------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------

export interface ObjectEntry {
  key: string;
  size: number;
  etag?: string;
  lastModified?: Date;
}

export function backupPrefix(logical: BackupLogicalBucket): string {
  return `${logical}/`;
}

export function backupKeyFor(logical: BackupLogicalBucket, sourceKey: string): string {
  return `${backupPrefix(logical)}${sourceKey}`;
}

const unquote = (etag: string | undefined) => etag?.replace(/"/g, '');

/** True when the backup copy already holds the source object's bytes. */
export function isUpToDate(source: ObjectEntry, backup: ObjectEntry): boolean {
  if (source.size !== backup.size) return false;
  const a = unquote(source.etag);
  if (a && a === unquote(backup.etag)) return true;
  // A different ETag with the same size: current when the copy was made after the source was
  // last written (server-side copies of multipart objects get a new ETag).
  return (
    source.lastModified !== undefined &&
    backup.lastModified !== undefined &&
    backup.lastModified.getTime() >= source.lastModified.getTime()
  );
}

export interface BucketPlan {
  logical: BackupLogicalBucket;
  /** New or changed source objects to copy. */
  copy: ObjectEntry[];
  copyBytes: number;
  upToDate: number;
  /** Source objects over MAX_SINGLE_COPY_BYTES (reported, not copied). */
  tooLarge: ObjectEntry[];
  /** Backup keys whose source was first seen missing in this run. */
  newlyMissing: string[];
  /** Backup keys still waiting out the retention period. */
  waiting: number;
  /** Backup keys whose tombstone is RETENTION_DAYS old: delete them. */
  expire: string[];
  /** Tombstones cleared because the source object is back. */
  revived: number;
  /** The tombstones for this prefix after the run (backup key → ISO time first seen missing). */
  tombstones: Record<string, string>;
  /** Set when the mass-tombstone valve stopped this bucket: nothing is tombstoned or expired. */
  blocked?: string;
}

export interface PlanInput {
  logical: BackupLogicalBucket;
  source: ObjectEntry[];
  /** The backup bucket's objects under backupPrefix(logical), full backup keys. */
  backup: ObjectEntry[];
  /** Existing tombstones (any prefix; only this bucket's are used). */
  tombstones: Record<string, string>;
  now: Date;
  retentionDays: number;
  allowMassTombstone?: boolean;
}

export function planBucket(input: PlanInput): BucketPlan {
  const prefix = backupPrefix(input.logical);
  const backupByKey = new Map(input.backup.map((o) => [o.key, o]));
  const sourceKeys = new Set<string>();
  const plan: BucketPlan = {
    logical: input.logical,
    copy: [],
    copyBytes: 0,
    upToDate: 0,
    tooLarge: [],
    newlyMissing: [],
    waiting: 0,
    expire: [],
    revived: 0,
    tombstones: {},
  };

  for (const object of input.source) {
    const key = backupKeyFor(input.logical, object.key);
    sourceKeys.add(key);
    const copy = backupByKey.get(key);
    if (copy && isUpToDate(object, copy)) plan.upToDate += 1;
    else if (object.size > MAX_SINGLE_COPY_BYTES) plan.tooLarge.push(object);
    else {
      plan.copy.push(object);
      plan.copyBytes += object.size;
    }
  }

  const cutoff = input.now.getTime() - input.retentionDays * DAY_MS;
  const existing = new Map<string, string>();
  for (const [key, since] of Object.entries(input.tombstones)) {
    if (!key.startsWith(prefix)) continue;
    if (sourceKeys.has(key)) plan.revived += 1;
    // A tombstone whose backup copy is already gone (deleted earlier) is dropped too.
    else if (backupByKey.has(key)) existing.set(key, since);
  }
  const orphans = input.backup.filter((o) => !sourceKeys.has(o.key)).map((o) => o.key);
  const fresh = orphans.filter((key) => !existing.has(key));

  const massive =
    (input.source.length === 0 && input.backup.length > 0) ||
    (fresh.length >= MASS_TOMBSTONE_MIN_OBJECTS &&
      fresh.length > MASS_TOMBSTONE_RATIO * input.backup.length);
  if (massive && !input.allowMassTombstone) {
    plan.blocked =
      `${fresh.length} of ${input.backup.length} backup copies would start their ` +
      `${input.retentionDays}-day clock at once (source listing ${input.source.length} objects). ` +
      'Check the S3_BUCKET_* names; re-run with --allow-mass-tombstone if the deletes are real.';
    // Keep the existing tombstones unchanged, and expire nothing, until a person has looked.
    for (const [key, since] of existing) plan.tombstones[key] = since;
    plan.waiting = existing.size;
    return plan;
  }

  const nowIso = input.now.toISOString();
  for (const key of fresh) {
    plan.newlyMissing.push(key);
    plan.tombstones[key] = nowIso;
  }
  for (const [key, since] of existing) {
    const at = Date.parse(since);
    if (Number.isFinite(at) && at <= cutoff) plan.expire.push(key);
    else plan.tombstones[key] = since;
  }
  plan.waiting = Object.keys(plan.tombstones).length;
  return plan;
}

// ---------------------------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------------------------

const stateSchema = z
  .object({
    version: z.literal(1),
    updatedAt: z.string(),
    tombstones: z.record(z.string(), z.iso.datetime()),
  })
  .strict();

export type BackupState = z.infer<typeof stateSchema>;

/**
 * undefined (no state yet) → empty. A state file that does not parse is an error, not a reset:
 * resetting would restart every retention clock and keep purged data longer than promised.
 */
export function parseState(raw: string | undefined): BackupState {
  if (raw === undefined)
    return { version: 1, updatedAt: new Date(0).toISOString(), tombstones: {} };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigurationError(`${STATE_KEY} in the backup bucket is not valid JSON`);
  }
  const parsed = stateSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigurationError(`${STATE_KEY} in the backup bucket has an unexpected shape`, {
      problems: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  return parsed.data;
}

export function serialiseState(tombstones: Record<string, string>, now: Date): string {
  const sorted = Object.fromEntries(
    Object.entries(tombstones).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  const state: BackupState = { version: 1, updatedAt: now.toISOString(), tombstones: sorted };
  return `${JSON.stringify(state, null, 2)}\n`;
}

// ---------------------------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------------------------

export interface BackupArgs {
  apply: boolean;
  only: BackupLogicalBucket[];
  concurrency: number;
  allowMassTombstone: boolean;
}

const MAX_CONCURRENCY = 32;

/** CLI flags of scripts/ops/backup-storage.ts. */
export function parseBackupArgs(argv: string[]): BackupArgs {
  const args: BackupArgs = {
    apply: false,
    only: [...DEFAULT_BACKUP_BUCKETS],
    concurrency: 8,
    allowMassTombstone: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--apply') args.apply = true;
    else if (flag === '--allow-mass-tombstone') args.allowMassTombstone = true;
    else if (flag === '--only' || flag === '--concurrency') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new ValidationError(`${flag} needs a value`);
      i += 1;
      if (flag === '--concurrency') {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > MAX_CONCURRENCY) {
          throw new ValidationError(`--concurrency must be 1-${MAX_CONCURRENCY}`);
        }
        args.concurrency = n;
      } else {
        const names = value.split(',').map((s) => s.trim());
        const unknown = names.filter(
          (n) => !(BACKUP_LOGICAL_BUCKETS as readonly string[]).includes(n),
        );
        if (unknown.length) throw new ValidationError(`unknown bucket(s): ${unknown.join(', ')}`);
        args.only = names as BackupLogicalBucket[];
      }
    } else throw new ValidationError(`unknown option ${flag}`);
  }
  return args;
}
