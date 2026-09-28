import { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { ConfigurationError } from '../../errors';
import { STATE_KEY, type ObjectEntry } from './storage-backup';
import {
  copySource,
  createS3BackupIo,
  formatReport,
  runBackup,
  type BackupIo,
  type DeleteResult,
  type RunOptions,
} from './storage-backup-run';

// Phase 17.5 — the backup run against an in-memory store, and the S3/R2 calls it makes.

const DAY = 86_400_000;
const T0 = new Date('2026-09-28T03:30:00Z');

/** Two "buckets" in memory: bucket → key → object. */
function memoryIo(initial: Record<string, ObjectEntry[]>) {
  const buckets = new Map<string, Map<string, ObjectEntry>>();
  for (const [name, objects] of Object.entries(initial)) {
    buckets.set(name, new Map(objects.map((o) => [o.key, o])));
  }
  const bucket = (name: string) => {
    if (!buckets.has(name)) buckets.set(name, new Map());
    return buckets.get(name)!;
  };
  let state: string | undefined;
  let clock = T0;
  const failCopy = new Set<string>();
  const failDelete = new Set<string>();
  const io: BackupIo = {
    listSource: async (name) => [...bucket(name).values()],
    listBackup: async (name, prefix) =>
      [...bucket(name).values()].filter((o) => o.key.startsWith(prefix)),
    copy: async ({ sourceBucket, sourceKey, backupBucket, backupKey }) => {
      if (failCopy.has(sourceKey)) throw new Error('AccessDenied');
      const src = bucket(sourceBucket).get(sourceKey)!;
      bucket(backupBucket).set(backupKey, { ...src, key: backupKey, lastModified: clock });
    },
    deleteBackup: async (name, keys): Promise<DeleteResult> => {
      const errors = keys
        .filter((k) => failDelete.has(k))
        .map((key) => ({ key, message: 'AccessDenied' }));
      for (const k of keys) if (!failDelete.has(k)) bucket(name).delete(k);
      return { deleted: keys.length - errors.length, errors };
    },
    readState: async () => state,
    writeState: async (_b, key, body) => {
      expect(key).toBe(STATE_KEY);
      state = body;
    },
  };
  return {
    io,
    bucket,
    failCopy,
    failDelete,
    state: () =>
      state ? (JSON.parse(state) as { tombstones: Record<string, string> }) : undefined,
    setClock: (d: Date) => {
      clock = d;
    },
  };
}

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const obj = (key: string, size = 5): ObjectEntry => ({
  key,
  size,
  etag: `"${key}"`,
  lastModified: new Date('2026-09-01T00:00:00Z'),
});

function options(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    sources: [
      { logical: 'assets', bucket: 'live-assets' },
      { logical: 'renders', bucket: 'live-renders' },
    ],
    backupBucket: 'backup',
    retentionDays: 30,
    serverSideCopy: true,
    apply: true,
    now: () => T0,
    log: log(),
    ...overrides,
  };
}

describe('runBackup', () => {
  it('dry run: plans, writes nothing', async () => {
    const m = memoryIo({ 'live-assets': [obj('orgs/o/a.mp4')], 'live-renders': [] });
    const report = await runBackup(m.io, options({ apply: false }));
    expect(report.buckets[0]).toMatchObject({ toCopy: 1, copied: 0 });
    expect(m.bucket('backup').size).toBe(0);
    expect(report.stateWritten).toBe(false);
    expect(formatReport(report)).toContain('Dry run');
  });

  it('copies new objects, then is incremental', async () => {
    const m = memoryIo({
      'live-assets': [obj('orgs/o/a.mp4', 100), obj('orgs/o/b.png', 7)],
      'live-renders': [obj('orgs/o/r.mp4', 50)],
    });
    const first = await runBackup(m.io, options());
    expect(first.ok).toBe(true);
    expect(first.buckets.map((b) => [b.logical, b.copied, b.copiedBytes])).toEqual([
      ['assets', 2, 107],
      ['renders', 1, 50],
    ]);
    expect([...m.bucket('backup').keys()].sort()).toEqual([
      'assets/orgs/o/a.mp4',
      'assets/orgs/o/b.png',
      'renders/orgs/o/r.mp4',
    ]);
    const second = await runBackup(m.io, options());
    expect(second.buckets.map((b) => [b.toCopy, b.upToDate])).toEqual([
      [0, 2],
      [0, 1],
    ]);
  });

  it('ages out a purged organisation after the retention period, not before', async () => {
    const m = memoryIo({
      'live-assets': [obj('orgs/purged/a.mp4'), obj('orgs/kept/b.mp4')],
      'live-renders': [],
    });
    await runBackup(m.io, options());
    // Organisation hard delete (purge-storage.ts) removes orgs/purged/ from the live bucket.
    m.bucket('live-assets').delete('orgs/purged/a.mp4');

    const day0 = await runBackup(m.io, options());
    expect(day0.buckets[0]).toMatchObject({ newlyMissing: 1, waiting: 1, expired: 0 });
    expect(m.state()?.tombstones).toEqual({ 'assets/orgs/purged/a.mp4': T0.toISOString() });

    const day29 = await runBackup(m.io, options({ now: () => new Date(T0.getTime() + 29 * DAY) }));
    expect(day29.buckets[0]).toMatchObject({ newlyMissing: 0, waiting: 1, expired: 0 });
    expect(m.bucket('backup').has('assets/orgs/purged/a.mp4')).toBe(true);

    const day30 = await runBackup(m.io, options({ now: () => new Date(T0.getTime() + 30 * DAY) }));
    expect(day30.buckets[0]).toMatchObject({ toExpire: 1, expired: 1, waiting: 0 });
    expect(m.bucket('backup').has('assets/orgs/purged/a.mp4')).toBe(false);
    expect(m.bucket('backup').has('assets/orgs/kept/b.mp4')).toBe(true);
    expect(m.state()?.tombstones).toEqual({});
  });

  it('a failed delete keeps its original tombstone and fails the run', async () => {
    const m = memoryIo({ 'live-assets': [obj('orgs/x/a'), obj('keep')], 'live-renders': [] });
    await runBackup(m.io, options());
    m.bucket('live-assets').delete('orgs/x/a');
    await runBackup(m.io, options());
    m.failDelete.add('assets/orgs/x/a');
    const later = await runBackup(m.io, options({ now: () => new Date(T0.getTime() + 31 * DAY) }));
    expect(later.ok).toBe(false);
    expect(later.buckets[0]!.errors).toEqual(['delete assets/orgs/x/a: AccessDenied']);
    expect(m.state()?.tombstones).toEqual({ 'assets/orgs/x/a': T0.toISOString() });
  });

  it('a failed copy is reported and fails the run; the others still copy', async () => {
    const m = memoryIo({ 'live-assets': [obj('a'), obj('b')], 'live-renders': [] });
    m.failCopy.add('a');
    const report = await runBackup(m.io, options());
    expect(report.ok).toBe(false);
    expect(report.buckets[0]).toMatchObject({ copied: 1, toCopy: 2 });
    expect(report.buckets[0]!.errors).toEqual(['copy a: AccessDenied']);
    expect(formatReport(report)).toContain('FAILED');
  });

  it('a listing failure keeps that bucket’s tombstones and fails the run', async () => {
    const m = memoryIo({ 'live-assets': [obj('a'), obj('keep')], 'live-renders': [] });
    await runBackup(m.io, options());
    m.bucket('live-assets').delete('a');
    await runBackup(m.io, options());
    const broken: BackupIo = {
      ...m.io,
      listSource: async (b) => {
        if (b === 'live-assets') throw new Error('NoSuchBucket');
        return m.io.listSource(b);
      },
    };
    const report = await runBackup(broken, options());
    expect(report.ok).toBe(false);
    expect(report.buckets[0]!.errors).toEqual(['list: NoSuchBucket']);
    expect(m.state()?.tombstones).toEqual({ 'assets/a': T0.toISOString() });
  });

  it('the mass-tombstone valve stops the bucket and fails the run', async () => {
    const many = Array.from({ length: 150 }, (_, i) => obj(`k${i}`));
    const m = memoryIo({ 'live-assets': many, 'live-renders': [] });
    await runBackup(m.io, options());
    m.bucket('live-assets').clear();
    const report = await runBackup(m.io, options());
    expect(report.ok).toBe(false);
    expect(report.buckets[0]!.blocked).toBeDefined();
    expect(m.state()?.tombstones).toEqual({});
    expect(formatReport(report)).toContain('STOPPED');
  });

  it('keeps tombstones of buckets that are not part of this run', async () => {
    const m = memoryIo({ 'live-assets': [], 'live-renders': [] });
    await m.io.writeState(
      'backup',
      STATE_KEY,
      JSON.stringify({
        version: 1,
        updatedAt: T0.toISOString(),
        tombstones: { 'library/x': T0.toISOString() },
      }),
    );
    await runBackup(m.io, options());
    expect(m.state()?.tombstones).toEqual({ 'library/x': T0.toISOString() });
  });

  it('refuses to run on a corrupt state file', async () => {
    const m = memoryIo({});
    await m.io.writeState('backup', STATE_KEY, 'not json');
    await expect(runBackup(m.io, options())).rejects.toThrow(ConfigurationError);
  });

  it('emits one structured line per bucket and one per run', async () => {
    const m = memoryIo({ 'live-assets': [obj('a')], 'live-renders': [] });
    const logger = log();
    await runBackup(m.io, options({ log: logger }));
    const events = logger.info.mock.calls.map((c) => (c[0] as { event: string }).event);
    expect(events).toEqual([
      'storage_backup_bucket',
      'storage_backup_bucket',
      'storage_backup_run',
    ]);
    expect(logger.info.mock.calls[2]![0]).toMatchObject({ ok: true, copied: 1, copiedBytes: 5 });
  });
});

describe('createS3BackupIo', () => {
  function stub(handler: (command: unknown) => unknown) {
    const send = vi.fn(async (command: unknown) => handler(command));
    return { client: { send } as unknown as S3Client, send };
  }

  it('lists every page of a bucket', async () => {
    const pages = [
      {
        Contents: [{ Key: 'a', Size: 1, ETag: '"e"', LastModified: T0 }],
        IsTruncated: true,
        NextContinuationToken: 't',
      },
      { Contents: [{ Key: 'b', Size: 2 }], IsTruncated: false },
    ];
    const { client, send } = stub(() => pages.shift());
    const io = createS3BackupIo({ source: client, backup: client, serverSideCopy: true });
    expect(await io.listSource('bucket')).toEqual([
      { key: 'a', size: 1, etag: '"e"', lastModified: T0 },
      { key: 'b', size: 2 },
    ]);
    const inputs = send.mock.calls.map((c) => (c[0] as ListObjectsV2Command).input);
    expect(inputs[0]).toMatchObject({ Bucket: 'bucket', MaxKeys: 1000 });
    expect(inputs[0]).not.toHaveProperty('Prefix');
    expect(inputs[1]).toMatchObject({ ContinuationToken: 't' });
  });

  it('server-side copy: CopyObject on the backup client with an encoded copy source', async () => {
    const { client: source, send: sourceSend } = stub(() => ({}));
    const { client: backup, send } = stub(() => ({}));
    const io = createS3BackupIo({ source, backup, serverSideCopy: true });
    await io.copy({
      sourceBucket: 'live',
      sourceKey: 'orgs/o/my file#1.mp4',
      backupBucket: 'bk',
      backupKey: 'assets/orgs/o/my file#1.mp4',
    });
    expect(sourceSend).not.toHaveBeenCalled();
    const command = send.mock.calls[0]![0];
    expect(command).toBeInstanceOf(CopyObjectCommand);
    expect((command as CopyObjectCommand).input).toEqual({
      Bucket: 'bk',
      Key: 'assets/orgs/o/my file#1.mp4',
      CopySource: 'live/orgs/o/my%20file%231.mp4',
    });
    expect(copySource('b', 'a/b c')).toBe('b/a/b%20c');
  });

  it('other endpoint: streams GET → PUT with length, type and metadata', async () => {
    const body = Readable.from(['bytes']);
    const { client: source } = stub((c) => {
      expect(c).toBeInstanceOf(GetObjectCommand);
      return {
        Body: body,
        ContentLength: 5,
        ContentType: 'video/mp4',
        CacheControl: 'private',
        Metadata: { a: 'b' },
      };
    });
    const { client: backup, send } = stub(() => ({}));
    const io = createS3BackupIo({ source, backup, serverSideCopy: false });
    await io.copy({
      sourceBucket: 'live',
      sourceKey: 'k',
      backupBucket: 'bk',
      backupKey: 'assets/k',
    });
    const put = send.mock.calls[0]![0] as PutObjectCommand;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toMatchObject({
      Bucket: 'bk',
      Key: 'assets/k',
      Body: body,
      ContentLength: 5,
      ContentType: 'video/mp4',
      CacheControl: 'private',
      Metadata: { a: 'b' },
    });
  });

  it('deletes in batches of 1,000 and returns the failures', async () => {
    const keys = Array.from({ length: 1001 }, (_, i) => `assets/${i}`);
    const { client, send } = stub((c) => {
      const input = (c as DeleteObjectsCommand).input;
      return input.Delete!.Objects!.length === 1
        ? { Errors: [{ Key: 'assets/1000', Code: 'AccessDenied', Message: 'no' }] }
        : {};
    });
    const io = createS3BackupIo({ source: client, backup: client, serverSideCopy: true });
    expect(await io.deleteBackup('bk', keys)).toEqual({
      deleted: 1000,
      errors: [{ key: 'assets/1000', message: 'AccessDenied: no' }],
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect((send.mock.calls[0]![0] as DeleteObjectsCommand).input.Delete!.Quiet).toBe(true);
  });

  it('state: missing → undefined, present → text, write → JSON object', async () => {
    let stored: unknown;
    const { client } = stub((c) => {
      if (c instanceof GetObjectCommand) {
        if (stored === undefined) {
          throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        }
        return { Body: { transformToString: async () => 'saved' } };
      }
      stored = (c as PutObjectCommand).input;
      return {};
    });
    const io = createS3BackupIo({ source: client, backup: client, serverSideCopy: true });
    expect(await io.readState('bk', STATE_KEY)).toBeUndefined();
    await io.writeState('bk', STATE_KEY, '{}');
    expect(stored).toMatchObject({ Bucket: 'bk', Key: STATE_KEY, ContentType: 'application/json' });
    expect(await io.readState('bk', STATE_KEY)).toBe('saved');
  });

  it('state: other read errors propagate', async () => {
    const { client } = stub(() => {
      throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
    });
    const io = createS3BackupIo({ source: client, backup: client, serverSideCopy: true });
    await expect(io.readState('bk', STATE_KEY)).rejects.toThrow('denied');
  });
});
