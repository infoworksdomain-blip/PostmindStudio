import {
  CopyObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import {
  backfillThumbnailCacheHeaders,
  copySource,
  parseBackfillArgs,
} from './thumbnail-cache-headers';

// BACKLOG 20.15 — scripts/library/set-thumbnail-cache-headers.ts: dry run vs real run against a
// mocked S3 client (list → head → copy-onto-itself with REPLACE).

const TARGET = 'public, max-age=604800, immutable';

interface FakeObject {
  contentType?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
  failHead?: boolean;
}

function fakeS3(objects: Record<string, FakeObject>, pageSize = 2) {
  const keys = Object.keys(objects);
  const copies: CopyObjectCommand['input'][] = [];
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof ListObjectsV2Command) {
      const start = Number(command.input.ContinuationToken ?? '0');
      const page = keys.filter((k) => k.startsWith(command.input.Prefix ?? ''));
      const slice = page.slice(start, start + pageSize);
      const next = start + pageSize;
      return {
        Contents: slice.map((Key) => ({ Key })),
        IsTruncated: next < page.length,
        NextContinuationToken: next < page.length ? String(next) : undefined,
      };
    }
    if (command instanceof HeadObjectCommand) {
      const o = objects[command.input.Key ?? ''];
      if (!o || o.failHead) throw new Error('AccessDenied');
      return { ContentType: o.contentType, CacheControl: o.cacheControl, Metadata: o.metadata };
    }
    if (command instanceof CopyObjectCommand) {
      copies.push(command.input);
      return {};
    }
    throw new Error('unexpected command');
  });
  return { client: { send } as unknown as Pick<S3Client, 'send'>, send, copies };
}

const corpus = (): Record<string, FakeObject> => ({
  'library/aaa.mp4': { contentType: 'video/mp4' },
  'library/aaa-preview.mp4': { contentType: 'video/mp4' },
  'library/aaa-thumb.jpg': { contentType: 'image/jpeg', metadata: { origin: 'ingest' } },
  'library/bbb-thumb.jpg': { contentType: 'image/jpeg', cacheControl: TARGET },
  'library/ccc-thumb.jpg': {},
  'library/staging/x-thumb.jpg': { contentType: 'image/jpeg' },
});

describe('backfillThumbnailCacheHeaders', () => {
  it('dry run: counts what would change and writes nothing', async () => {
    const { client, copies } = fakeS3(corpus());
    const report = await backfillThumbnailCacheHeaders(client, { bucket: 'lib', dryRun: true });
    expect(report).toEqual({
      dryRun: true,
      scanned: 6,
      matched: 3,
      alreadySet: 1,
      updated: 2,
      failed: [],
    });
    expect(copies).toHaveLength(0);
  });

  it('real run: copies each thumbnail onto itself with REPLACE, keeping type and metadata', async () => {
    const { client, copies } = fakeS3(corpus());
    const report = await backfillThumbnailCacheHeaders(client, { bucket: 'lib', dryRun: false });
    expect(report.updated).toBe(2);
    expect(report.alreadySet).toBe(1);
    expect(copies).toEqual([
      {
        Bucket: 'lib',
        Key: 'library/aaa-thumb.jpg',
        CopySource: 'lib/library/aaa-thumb.jpg',
        MetadataDirective: 'REPLACE',
        ContentType: 'image/jpeg',
        CacheControl: TARGET,
        Metadata: { origin: 'ingest' },
      },
      {
        Bucket: 'lib',
        Key: 'library/ccc-thumb.jpg',
        CopySource: 'lib/library/ccc-thumb.jpg',
        MetadataDirective: 'REPLACE',
        ContentType: 'image/jpeg',
        CacheControl: TARGET,
      },
    ]);
    // Nothing that is not a thumbnail is touched (sources, previews, staging).
    expect(copies.map((c) => c.Key)).not.toContain('library/aaa.mp4');
  });

  it('a second run changes nothing (idempotent)', async () => {
    const objects = corpus();
    const first = fakeS3(objects);
    await backfillThumbnailCacheHeaders(first.client, { bucket: 'lib', dryRun: false });
    for (const copy of first.copies) {
      const o = objects[copy.Key ?? ''];
      if (o) o.cacheControl = copy.CacheControl;
    }
    const second = fakeS3(objects);
    const report = await backfillThumbnailCacheHeaders(second.client, {
      bucket: 'lib',
      dryRun: false,
    });
    expect(report.updated).toBe(0);
    expect(report.alreadySet).toBe(3);
    expect(second.copies).toHaveLength(0);
  });

  it('records per-object failures and carries on', async () => {
    const objects = corpus();
    objects['library/aaa-thumb.jpg'] = { failHead: true };
    const { client } = fakeS3(objects);
    const warn = vi.fn();
    const report = await backfillThumbnailCacheHeaders(
      client,
      { bucket: 'lib', dryRun: false },
      { info: vi.fn(), warn },
    );
    expect(report.failed).toEqual([{ key: 'library/aaa-thumb.jpg', message: 'AccessDenied' }]);
    expect(report.updated).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('stops after --limit matching objects', async () => {
    const { client, copies } = fakeS3(corpus());
    const report = await backfillThumbnailCacheHeaders(client, {
      bucket: 'lib',
      dryRun: false,
      limit: 1,
    });
    expect(report.matched).toBe(1);
    expect(copies).toHaveLength(1);
  });

  it('rejects a missing bucket or a bad limit', async () => {
    const { client } = fakeS3({});
    await expect(
      backfillThumbnailCacheHeaders(client, { bucket: ' ', dryRun: true }),
    ).rejects.toThrow('bucket');
    await expect(
      backfillThumbnailCacheHeaders(client, { bucket: 'b', dryRun: true, limit: 0 }),
    ).rejects.toThrow('limit');
  });

  it('URL-encodes key segments in CopySource', () => {
    expect(copySource('lib', 'library/a b+c-thumb.jpg')).toBe('lib/library/a%20b%2Bc-thumb.jpg');
  });
});

describe('parseBackfillArgs', () => {
  it('reads --dry-run, --limit and --bucket', () => {
    expect(parseBackfillArgs([])).toEqual({ dryRun: false });
    expect(parseBackfillArgs(['--dry-run', '--limit', '5', '--bucket', 'lib'])).toEqual({
      dryRun: true,
      limit: 5,
      bucket: 'lib',
    });
  });

  it('rejects unknown flags and bad values', () => {
    expect(() => parseBackfillArgs(['--apply'])).toThrow('unknown option');
    expect(() => parseBackfillArgs(['--limit'])).toThrow('needs a value');
    expect(() => parseBackfillArgs(['--limit', 'x'])).toThrow('positive integer');
  });
});
