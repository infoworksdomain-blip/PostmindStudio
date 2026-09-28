import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { memoryStorage } from '../../../../test/helpers/memory-storage';
import { ABANDONED_AFTER_MS, ABANDONED_REASON, sweepAbandonedUploads } from './upload-sweep';

// BACKLOG 14.2 — abandoned uploads are app logic, not an S3 lifecycle rule: only PENDING uploads
// whose presigned URL expired more than a day ago lose their object; READY uploads never do.

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('sweepAbandonedUploads', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `svc-sweep-${randomUUID()}`;
  const now = Date.parse('2026-09-28T12:00:00Z');

  afterAll(async () => {
    await db.videoUpload.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  it('deletes abandoned PENDING uploads only', async () => {
    const { storage, objects } = memoryStorage();
    const upload = async (state: 'PENDING' | 'READY', expiresAt: number) => {
      const id = randomUUID();
      const key = `orgs/${org}/uploads/${id}/source.mp4`;
      await storage.put({
        bucket: 'assets',
        key,
        body: new Uint8Array(1),
        contentType: 'video/mp4',
      });
      return db.videoUpload.create({
        data: {
          id,
          organisationId: org,
          createdByUserId: 'u',
          kind: 'SOURCE_VIDEO',
          fileName: 'a.mp4',
          contentType: 'video/mp4',
          declaredBytes: BigInt(1),
          s3Bucket: 'assets',
          s3Key: key,
          state,
          expiresAt: new Date(expiresAt),
        },
      });
    };
    const abandoned = await upload('PENDING', now - ABANDONED_AFTER_MS - 1);
    const recent = await upload('PENDING', now - 60_000);
    const ready = await upload('READY', now - 30 * ABANDONED_AFTER_MS);

    const out = await sweepAbandonedUploads({
      db,
      storage,
      now: () => now,
      logger: pino({ level: 'silent' }),
    });
    expect(out.swept).toBeGreaterThanOrEqual(1);
    expect(objects.has(`assets/${abandoned.s3Key}`)).toBe(false);
    expect(objects.has(`assets/${recent.s3Key}`)).toBe(true);
    expect(objects.has(`assets/${ready.s3Key}`)).toBe(true);
    expect(await db.videoUpload.findUniqueOrThrow({ where: { id: abandoned.id } })).toMatchObject({
      state: 'FAILED',
      errorReason: ABANDONED_REASON,
    });
    expect((await db.videoUpload.findUniqueOrThrow({ where: { id: recent.id } })).state).toBe(
      'PENDING',
    );
    expect((await db.videoUpload.findUniqueOrThrow({ where: { id: ready.id } })).state).toBe(
      'READY',
    );
  });
});
