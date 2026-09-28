import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { memoryStorage } from '../../../../test/helpers/memory-storage';
import { UpstreamServiceError, ValidationError } from '../../errors';
import {
  countKeysOutsidePrefix,
  countPrefix,
  deletePrefix,
  orgPrefix,
  purgeBucketsFromEnv,
} from './purge-storage';

// BACKLOG 14.1 — the S3 half of the hard delete: prefix safety, paging, and refusal handling.

async function seed(n: number, prefix: string) {
  const mem = memoryStorage();
  for (let i = 0; i < n; i += 1) {
    await mem.storage.put({
      bucket: 'b',
      key: `${prefix}${String(i).padStart(5, '0')}.bin`,
      body: new Uint8Array(2),
      contentType: 'application/octet-stream',
    });
  }
  return mem;
}

describe('orgPrefix', () => {
  it('scopes to orgs/<id>/ with a trailing slash (org1 never matches org10)', () => {
    expect(orgPrefix('org1')).toBe('orgs/org1/');
  });

  it('refuses ids that could escape or widen the prefix', () => {
    for (const bad of ['', 'a/b', '../x', '.', 'a b', 'x'.repeat(200)]) {
      expect(() => orgPrefix(bad), bad).toThrow(ValidationError);
    }
  });
});

describe('purgeBucketsFromEnv', () => {
  it('lists the configured buckets and skips blanks', () => {
    expect(
      purgeBucketsFromEnv({
        S3_BUCKET_ASSETS: 'a',
        S3_BUCKET_RENDERS: ' r ',
        S3_BUCKET_THUMBNAILS: '',
      }),
    ).toEqual(['a', 'r']);
  });
});

describe('countPrefix / deletePrefix', () => {
  it('pages through more than 1,000 objects and deletes only under the prefix', async () => {
    const { storage, objects } = await seed(2_345, 'orgs/o1/');
    await storage.put({
      bucket: 'b',
      key: 'orgs/o10/keep.bin',
      body: new Uint8Array(1),
      contentType: 'x',
    });
    expect(await countPrefix(storage, 'b', 'orgs/o1/')).toEqual({
      bucket: 'b',
      prefix: 'orgs/o1/',
      objects: 2_345,
      bytes: 4_690,
      truncated: false,
    });
    expect(await countPrefix(storage, 'b', 'orgs/o1/', 2)).toMatchObject({
      objects: 2_000,
      truncated: true,
    });
    expect(await deletePrefix(storage, 'b', 'orgs/o1/')).toEqual({ objects: 2_345, bytes: 4_690 });
    expect([...objects.keys()]).toEqual(['b/orgs/o10/keep.bin']);
    // Idempotent: nothing left to delete.
    expect(await deletePrefix(storage, 'b', 'orgs/o1/')).toEqual({ objects: 0, bytes: 0 });
  });

  it('throws when S3 refuses keys, so the purge is retried', async () => {
    const { storage } = await seed(3, 'orgs/o1/');
    const refusing = {
      ...storage,
      deleteMany: async (_b: string, keys: string[]) => ({
        deleted: keys.length - 1,
        errors: [{ key: keys[0] ?? '', code: 'AccessDenied', message: 'no' }],
      }),
    };
    await expect(deletePrefix(refusing, 'b', 'orgs/o1/')).rejects.toThrow(UpstreamServiceError);
  });
});

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('countKeysOutsidePrefix', () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  // Contains '_', a LIKE wildcard: a prefix comparison built with LIKE (rather than a plain
  // substring match) would treat that '_' as "any character" and undercount keys outside the
  // organisation's real prefix.
  const org = `acct_${randomUUID().slice(0, 8)}`;

  afterAll(async () => {
    await db.videoUpload.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  it('does not let "_" in the organisation id widen the prefix match', async () => {
    const wildcardKey = orgPrefix(org).replace('_', 'X'); // one char stands in for the '_'
    await db.videoUpload.create({
      data: {
        organisationId: org,
        createdByUserId: 'u1',
        kind: 'SOURCE_VIDEO',
        fileName: 'leak.bin',
        contentType: 'video/mp4',
        declaredBytes: 1,
        s3Bucket: 'b',
        s3Key: `${wildcardKey}leak.bin`,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    expect(await countKeysOutsidePrefix(db, org)).toBe(1);
  });
});
