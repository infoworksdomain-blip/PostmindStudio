import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../errors';
import { memoryStorage } from '../../../../test/helpers/memory-storage';
import {
  ABANDONED_AFTER_MS,
  ABANDONED_REASON,
  sweepAbandonedUploads,
  uploadAbandonGraceMs,
} from './upload-sweep';

// BACKLOG 14.2 / 17.1 — abandoned uploads are app logic, not an S3 lifecycle rule: only PENDING
// uploads whose presigned URL expired more than the grace period ago lose their object; READY
// uploads never do, and neither does anything a project, slide or brand kit references.

const HOUR = 60 * 60 * 1000;

describe('uploadAbandonGraceMs (STUDIO_UPLOAD_ABANDON_GRACE_HOURS)', () => {
  it('defaults to 24 hours', () => {
    expect(uploadAbandonGraceMs({})).toBe(24 * HOUR);
    expect(uploadAbandonGraceMs({ STUDIO_UPLOAD_ABANDON_GRACE_HOURS: ' ' })).toBe(24 * HOUR);
    expect(ABANDONED_AFTER_MS).toBe(24 * HOUR);
  });

  it('reads whole hours from 1 to 720', () => {
    expect(uploadAbandonGraceMs({ STUDIO_UPLOAD_ABANDON_GRACE_HOURS: '1' })).toBe(HOUR);
    expect(uploadAbandonGraceMs({ STUDIO_UPLOAD_ABANDON_GRACE_HOURS: '72' })).toBe(72 * HOUR);
    for (const bad of ['0', '-1', '1.5', '721', 'day'])
      expect(() => uploadAbandonGraceMs({ STUDIO_UPLOAD_ABANDON_GRACE_HOURS: bad })).toThrow(
        ConfigurationError,
      );
  });
});

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('sweepAbandonedUploads', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `svc-sweep-${randomUUID()}`;
  const now = Date.parse('2026-09-28T12:00:00Z');
  const logger = pino({ level: 'silent' });

  afterAll(async () => {
    await db.videoUpload.deleteMany({ where: { organisationId: org } });
    await db.videoAsset.deleteMany({ where: { organisationId: org } });
    await db.brandKit.deleteMany({ where: { organisationId: org } });
    await db.videoProject.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  type Kind = 'SOURCE_VIDEO' | 'SLIDE_CLIP' | 'BRAND_LOGO' | 'BRAND_FONT';

  const setup = () => {
    const { storage, objects } = memoryStorage();
    const upload = async (
      state: 'PENDING' | 'READY',
      expiresAt: number,
      kind: Kind = 'SOURCE_VIDEO',
      projectId: string | null = null,
    ) => {
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
          kind,
          projectId,
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
    return { storage, objects, upload };
  };

  const project = (sourceType: 'SLIDESHOW' | 'UPLOAD', sourceRef?: string) =>
    db.videoProject.create({
      data: {
        organisationId: org,
        businessId: 'b',
        createdByUserId: 'u',
        name: 'p',
        state: 'DRAFT',
        sourceType,
        sourceRef: sourceRef ?? null,
        targetFormats: [],
      },
    });

  it('deletes abandoned PENDING uploads only', async () => {
    const { storage, objects, upload } = setup();
    const abandoned = await upload('PENDING', now - ABANDONED_AFTER_MS - 1);
    const recent = await upload('PENDING', now - 60_000);
    const ready = await upload('READY', now - 30 * ABANDONED_AFTER_MS);

    const out = await sweepAbandonedUploads({ db, storage, now: () => now, logger });
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

    // Idempotent: the next run leaves the swept and the recent rows as they are.
    await sweepAbandonedUploads({ db, storage, now: () => now, logger });
    expect((await db.videoUpload.findUniqueOrThrow({ where: { id: abandoned.id } })).state).toBe(
      'FAILED',
    );
    expect((await db.videoUpload.findUniqueOrThrow({ where: { id: recent.id } })).state).toBe(
      'PENDING',
    );
  });

  it('honours the configured grace period', async () => {
    const { storage, objects, upload } = setup();
    const twoHoursOld = await upload('PENDING', now - 2 * HOUR);
    await sweepAbandonedUploads({ db, storage, now: () => now, logger });
    expect(objects.has(`assets/${twoHoursOld.s3Key}`)).toBe(true);
    await sweepAbandonedUploads({ db, storage, now: () => now, logger, graceMs: HOUR });
    expect(objects.has(`assets/${twoHoursOld.s3Key}`)).toBe(false);
    expect((await db.videoUpload.findUniqueOrThrow({ where: { id: twoHoursOld.id } })).state).toBe(
      'FAILED',
    );
  });

  it('never touches a PENDING upload that a project, slide or brand kit references', async () => {
    const { storage, objects, upload } = setup();
    const old = now - 2 * ABANDONED_AFTER_MS;
    const slideshow = await project('SLIDESHOW');
    const byProject = await upload('PENDING', old);
    await project('UPLOAD', byProject.id);
    const bySlide = await upload('PENDING', old, 'SLIDE_CLIP', slideshow.id);
    await db.videoAsset.create({
      data: {
        organisationId: org,
        projectId: slideshow.id,
        kind: 'VIDEO_CLIP',
        source: 'upload',
        s3Bucket: bySlide.s3Bucket,
        s3Key: bySlide.s3Key,
      },
    });
    const byLogo = await upload('PENDING', old, 'BRAND_LOGO');
    const byFont = await upload('PENDING', old, 'BRAND_FONT');
    await db.brandKit.create({
      data: {
        organisationId: org,
        businessId: 'b',
        name: 'k',
        colourPalette: [],
        ctaTemplates: [],
        logoAssetId: byLogo.id,
        fontPrimary: `upload:${byFont.id}`,
      },
    });
    // A slide clip is created with its slideshow's projectId: that alone is not a reference.
    const unusedClip = await upload('PENDING', old, 'SLIDE_CLIP', slideshow.id);

    const out = await sweepAbandonedUploads({ db, storage, now: () => now, logger });
    for (const kept of [byProject, bySlide, byLogo, byFont]) {
      expect(out.skippedReferenced).toContain(kept.id);
      expect(objects.has(`assets/${kept.s3Key}`)).toBe(true);
      expect((await db.videoUpload.findUniqueOrThrow({ where: { id: kept.id } })).state).toBe(
        'PENDING',
      );
    }
    expect(objects.has(`assets/${unusedClip.s3Key}`)).toBe(false);
    expect((await db.videoUpload.findUniqueOrThrow({ where: { id: unusedClip.id } })).state).toBe(
      'FAILED',
    );
  });

  it('puts the row back when the object cannot be deleted, so the retry finds it', async () => {
    const { storage, upload } = setup();
    const stuck = await upload('PENDING', now - 2 * ABANDONED_AFTER_MS);
    const failing = {
      ...storage,
      delete: async () => {
        throw new Error('AccessDenied');
      },
    };
    await expect(
      sweepAbandonedUploads({ db, storage: failing, now: () => now, logger }),
    ).rejects.toThrow('AccessDenied');
    expect(await db.videoUpload.findUniqueOrThrow({ where: { id: stuck.id } })).toMatchObject({
      state: 'PENDING',
      errorReason: null,
    });
  });
});
