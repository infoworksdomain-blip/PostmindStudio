import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { Logger } from 'pino';
import { UpstreamServiceError } from '../../errors';
import {
  backupKeyFor,
  backupPrefix,
  parseState,
  planBucket,
  serialiseState,
  STATE_KEY,
  type BackupLogicalBucket,
  type BackupSource,
  type BucketPlan,
  type ObjectEntry,
} from './storage-backup';

// Phase 17.5 — runs the backup copy (plan in storage-backup.ts). S3 API used (AWS SDK v3, the same
// calls on R2 — https://developers.cloudflare.com/r2/api/s3/api/, read 2026-09-28):
//   ListObjectsV2  Key, Size, ETag, LastModified; ≤ 1,000 keys a page
//                  https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html
//   CopyObject     server-side copy; x-amz-copy-source = "<bucket>/<URL-encoded key>"; metadata
//                  and Content-Type are copied (MetadataDirective COPY, the default)
//                  https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html
//   GetObject → PutObject  when the backup bucket is behind another endpoint (another AWS
//                  region or R2 jurisdiction): streamed, Content-Length from the GET, standard
//                  headers and user metadata carried over
//   DeleteObjects  ≤ 1,000 keys, Quiet: only failures are returned
//                  https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html
// Dry run by default: lists and plans, writes nothing (no copy, no delete, no state).

export interface DeleteResult {
  deleted: number;
  errors: Array<{ key: string; message: string }>;
}

/** The storage calls the backup needs; S3/R2 below, in memory in the tests. */
export interface BackupIo {
  listSource(bucket: string): Promise<ObjectEntry[]>;
  listBackup(bucket: string, prefix: string): Promise<ObjectEntry[]>;
  copy(input: {
    sourceBucket: string;
    sourceKey: string;
    backupBucket: string;
    backupKey: string;
  }): Promise<void>;
  deleteBackup(bucket: string, keys: string[]): Promise<DeleteResult>;
  readState(bucket: string, key: string): Promise<string | undefined>;
  writeState(bucket: string, key: string, body: string): Promise<void>;
}

const MAX_KEYS = 1_000;

async function listAll(client: S3Client, bucket: string, prefix?: string): Promise<ObjectEntry[]> {
  const out: ObjectEntry[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ...(prefix && { Prefix: prefix }),
        ContinuationToken: token,
        MaxKeys: MAX_KEYS,
      }),
    );
    for (const o of page.Contents ?? []) {
      if (!o.Key) continue;
      out.push({
        key: o.Key,
        size: o.Size ?? 0,
        ...(o.ETag && { etag: o.ETag }),
        ...(o.LastModified && { lastModified: o.LastModified }),
      });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** x-amz-copy-source: bucket + URL-encoded key, '/' kept as the separator. */
export function copySource(bucket: string, key: string): string {
  return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

const isNoSuchKey = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404;
};

export function createS3BackupIo(input: {
  source: S3Client;
  backup: S3Client;
  serverSideCopy: boolean;
}): BackupIo {
  const { source, backup } = input;
  return {
    listSource: (bucket) => listAll(source, bucket),
    listBackup: (bucket, prefix) => listAll(backup, bucket, prefix),
    async copy({ sourceBucket, sourceKey, backupBucket, backupKey }) {
      if (input.serverSideCopy) {
        await backup.send(
          new CopyObjectCommand({
            Bucket: backupBucket,
            Key: backupKey,
            CopySource: copySource(sourceBucket, sourceKey),
          }),
        );
        return;
      }
      const got = await source.send(new GetObjectCommand({ Bucket: sourceBucket, Key: sourceKey }));
      if (!got.Body) {
        throw new UpstreamServiceError(
          `GetObject returned no body for ${sourceBucket}/${sourceKey}`,
        );
      }
      await backup.send(
        new PutObjectCommand({
          Bucket: backupBucket,
          Key: backupKey,
          Body: got.Body,
          ContentLength: got.ContentLength,
          ContentType: got.ContentType,
          ContentEncoding: got.ContentEncoding,
          ContentDisposition: got.ContentDisposition,
          ContentLanguage: got.ContentLanguage,
          CacheControl: got.CacheControl,
          Metadata: got.Metadata,
        }),
      );
    },
    async deleteBackup(bucket, keys) {
      const result: DeleteResult = { deleted: 0, errors: [] };
      for (let i = 0; i < keys.length; i += MAX_KEYS) {
        const batch = keys.slice(i, i + MAX_KEYS);
        const out = await backup.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        const errors = (out.Errors ?? []).map((e) => ({
          key: e.Key ?? '',
          message: `${e.Code ?? 'Error'}: ${e.Message ?? ''}`.trim(),
        }));
        result.errors.push(...errors);
        result.deleted += batch.length - errors.length;
      }
      return result;
    },
    async readState(bucket, key) {
      try {
        const got = await backup.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return got.Body ? await got.Body.transformToString('utf8') : undefined;
      } catch (err) {
        if (isNoSuchKey(err)) return undefined;
        throw err;
      }
    },
    async writeState(bucket, key, body) {
      await backup.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: 'application/json',
        }),
      );
    },
  };
}

// ---------------------------------------------------------------------------------------------

export interface BucketReport {
  logical: BackupLogicalBucket;
  bucket: string;
  sourceObjects: number;
  upToDate: number;
  toCopy: number;
  copyBytes: number;
  copied: number;
  copiedBytes: number;
  tooLarge: number;
  newlyMissing: number;
  waiting: number;
  toExpire: number;
  expired: number;
  revived: number;
  blocked?: string;
  errors: string[];
}

export interface BackupReport {
  apply: boolean;
  backupBucket: string;
  retentionDays: number;
  serverSideCopy: boolean;
  skipped: BackupLogicalBucket[];
  buckets: BucketReport[];
  stateWritten: boolean;
  durationMs: number;
  ok: boolean;
}

export interface RunOptions {
  sources: BackupSource[];
  skipped?: BackupLogicalBucket[];
  backupBucket: string;
  retentionDays: number;
  serverSideCopy: boolean;
  apply: boolean;
  allowMassTombstone?: boolean;
  /** Parallel copies (default 8). */
  concurrency?: number;
  now?: () => Date;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
}

async function forEachLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Copies and deletes one bucket's plan; returns the expired keys whose delete failed. */
async function applyPlan(
  io: BackupIo,
  source: BackupSource,
  plan: BucketPlan,
  report: BucketReport,
  options: RunOptions,
): Promise<string[]> {
  await forEachLimit(plan.copy, options.concurrency ?? 8, async (object) => {
    try {
      await io.copy({
        sourceBucket: source.bucket,
        sourceKey: object.key,
        backupBucket: options.backupBucket,
        backupKey: backupKeyFor(source.logical, object.key),
      });
      report.copied += 1;
      report.copiedBytes += object.size;
    } catch (err) {
      report.errors.push(`copy ${object.key}: ${message(err)}`);
    }
  });
  if (plan.expire.length === 0) return [];
  try {
    const result = await io.deleteBackup(options.backupBucket, plan.expire);
    report.expired = result.deleted;
    for (const e of result.errors) report.errors.push(`delete ${e.key}: ${e.message}`);
    return result.errors.map((e) => e.key);
  } catch (err) {
    report.errors.push(`delete: ${message(err)}`);
    return plan.expire;
  }
}

/** One structured line per bucket: counts, plus the first few errors (never thousands). */
function bucketLogLine(report: BucketReport, apply: boolean) {
  const { errors, ...counts } = report;
  return {
    event: 'storage_backup_bucket',
    apply,
    ...counts,
    errors: errors.length,
    firstErrors: errors.slice(0, 5),
  };
}

/**
 * One backup run. Returns the report; `ok` is false when a copy or delete failed, the mass
 * tombstone valve stopped a bucket, or a bucket could not be listed.
 */
export async function runBackup(io: BackupIo, options: RunOptions): Promise<BackupReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const state = parseState(await io.readState(options.backupBucket, STATE_KEY));
  const handled = new Set(options.sources.map((s) => backupPrefix(s.logical)));
  // Tombstones of buckets not in this run are carried over untouched.
  const nextTombstones: Record<string, string> = Object.fromEntries(
    Object.entries(state.tombstones).filter(
      ([key]) => ![...handled].some((p) => key.startsWith(p)),
    ),
  );
  const buckets: BucketReport[] = [];

  for (const source of options.sources) {
    const report: BucketReport = {
      logical: source.logical,
      bucket: source.bucket,
      sourceObjects: 0,
      upToDate: 0,
      toCopy: 0,
      copyBytes: 0,
      copied: 0,
      copiedBytes: 0,
      tooLarge: 0,
      newlyMissing: 0,
      waiting: 0,
      toExpire: 0,
      expired: 0,
      revived: 0,
      errors: [],
    };
    buckets.push(report);
    const prefix = backupPrefix(source.logical);
    let plan: BucketPlan;
    try {
      const [sourceObjects, backupObjects] = await Promise.all([
        io.listSource(source.bucket),
        io.listBackup(options.backupBucket, prefix),
      ]);
      report.sourceObjects = sourceObjects.length;
      plan = planBucket({
        logical: source.logical,
        source: sourceObjects,
        backup: backupObjects,
        tombstones: state.tombstones,
        now: startedAt,
        retentionDays: options.retentionDays,
        allowMassTombstone: options.allowMassTombstone,
      });
    } catch (err) {
      report.errors.push(`list: ${message(err)}`);
      // Could not plan: keep this bucket's tombstones exactly as they were.
      for (const [key, since] of Object.entries(state.tombstones)) {
        if (key.startsWith(prefix)) nextTombstones[key] = since;
      }
      options.log.error(bucketLogLine(report, options.apply), 'backup: listing failed');
      continue;
    }
    Object.assign(report, {
      upToDate: plan.upToDate,
      toCopy: plan.copy.length,
      copyBytes: plan.copyBytes,
      tooLarge: plan.tooLarge.length,
      newlyMissing: plan.newlyMissing.length,
      waiting: plan.waiting,
      toExpire: plan.expire.length,
      revived: plan.revived,
      ...(plan.blocked && { blocked: plan.blocked }),
    });
    for (const o of plan.tooLarge) {
      report.errors.push(`${o.key}: ${o.size} bytes is over the 5 GiB single-copy limit`);
    }
    Object.assign(nextTombstones, plan.tombstones);
    if (options.apply) {
      // A copy whose delete failed keeps its original tombstone: the next run retries it.
      for (const key of await applyPlan(io, source, plan, report, options)) {
        const since = state.tombstones[key];
        if (since) nextTombstones[key] = since;
      }
    }
    const level = report.errors.length || report.blocked ? 'warn' : 'info';
    options.log[level](bucketLogLine(report, options.apply), 'backup: bucket done');
  }

  let stateWritten = false;
  if (options.apply) {
    await io.writeState(options.backupBucket, STATE_KEY, serialiseState(nextTombstones, startedAt));
    stateWritten = true;
  }
  const report: BackupReport = {
    apply: options.apply,
    backupBucket: options.backupBucket,
    retentionDays: options.retentionDays,
    serverSideCopy: options.serverSideCopy,
    skipped: options.skipped ?? [],
    buckets,
    stateWritten,
    durationMs: now().getTime() - startedAt.getTime(),
    ok: buckets.every((b) => b.errors.length === 0 && !b.blocked),
  };
  options.log[report.ok ? 'info' : 'error'](
    {
      event: 'storage_backup_run',
      apply: report.apply,
      ok: report.ok,
      durationMs: report.durationMs,
      copied: buckets.reduce((n, b) => n + b.copied, 0),
      copiedBytes: buckets.reduce((n, b) => n + b.copiedBytes, 0),
      expired: buckets.reduce((n, b) => n + b.expired, 0),
      waiting: buckets.reduce((n, b) => n + b.waiting, 0),
      errors: buckets.reduce((n, b) => n + b.errors.length, 0),
    },
    'backup: run finished',
  );
  return report;
}

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

export function formatReport(report: BackupReport): string {
  const lines = [
    `Backup to ${report.backupBucket} (${report.serverSideCopy ? 'server-side copy' : 'streamed GET → PUT'}; ` +
      `deleted sources age out after ${report.retentionDays} days)`,
  ];
  for (const b of report.buckets) {
    lines.push(`${b.logical} (${b.bucket}): ${b.sourceObjects} objects`);
    lines.push(`  up to date ${b.upToDate}`);
    lines.push(
      report.apply
        ? `  copied ${b.copied}/${b.toCopy} (${mib(b.copiedBytes)})`
        : `  to copy ${b.toCopy} (${mib(b.copyBytes)})`,
    );
    lines.push(`  source deleted: ${b.newlyMissing} newly, ${b.waiting} waiting out retention`);
    lines.push(
      report.apply
        ? `  aged out and deleted ${b.expired}/${b.toExpire}`
        : `  would delete (aged out) ${b.toExpire}`,
    );
    if (b.revived) lines.push(`  restored sources (tombstone cleared) ${b.revived}`);
    if (b.blocked) lines.push(`  STOPPED: ${b.blocked}`);
    for (const e of b.errors.slice(0, 20)) lines.push(`  ERROR ${e}`);
    if (b.errors.length > 20) lines.push(`  … ${b.errors.length - 20} more errors`);
  }
  for (const s of report.skipped) lines.push(`${s}: skipped (its S3_BUCKET_* is not set)`);
  lines.push(
    report.apply
      ? `State ${report.stateWritten ? 'written' : 'NOT written'}. ${report.ok ? 'OK' : 'FAILED'} in ${report.durationMs} ms.`
      : 'Dry run: nothing copied, deleted or written. Re-run with --apply.',
  );
  return lines.join('\n');
}
