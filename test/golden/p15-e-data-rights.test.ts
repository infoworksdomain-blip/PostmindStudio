import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { strFromU8, unzipSync } from 'fflate';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as shareLinksRoute from '../../src/app/api/studio/projects/[id]/share-links/route';
import * as publicRoute from '../../src/app/api/studio/public/share-links/[token]/route';
import * as publicCommentsRoute from '../../src/app/api/studio/public/share-links/[token]/comments/route';
import * as exportRoute from '../../src/app/api/studio/account/export/route';
import * as businessPurgeRoute from '../../src/app/api/studio/internal/businesses/[id]/purge/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { runDataExport } from '../../src/lib/studio/services/export';
import { runRetentionSweep } from '../../src/lib/studio/services/retention';
import { call, installApi, tenant } from '../helpers/api-harness';

// Golden journey (Phase 15 track E): an owner shares a variant for feedback; an external reviewer
// (no account) watches and comments but cannot approve; the owner exports the organisation's data
// and finds the feedback in it, never a token; PostMind Core then deletes the business — the
// link dies at once, and after the 30-day grace the retention sweep removes the rows and files.

const hasDb = Boolean(process.env.DATABASE_URL);
const DAY = 86_400_000;
const SERVICE_TOKEN = 'g'.repeat(48);

describe.skipIf(!hasDb)(
  'golden: share, export, delete (15.E1 / E2 / E5 / E8)',
  { timeout: 90_000 },
  () => {
    const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
    const org = `golden-e-${randomUUID()}`;
    const biz = `golden-biz-${randomUUID()}`;
    let api: ReturnType<typeof installApi>;
    const projectIds: string[] = [];

    beforeAll(() => {
      vi.stubEnv('STUDIO_INTERNAL_SERVICE_TOKEN', SERVICE_TOKEN);
      api = installApi(db, { owner: tenant(org) });
    });

    afterAll(async () => {
      vi.unstubAllEnvs();
      setApiDeps(undefined);
      await db.dataExport.deleteMany({ where: { organisationId: org } });
      await db.notification.deleteMany({ where: { organisationId: org } });
      await db.businessPurge.deleteMany({ where: { organisationId: org } });
      const ids = (await db.videoProject.findMany({ where: { organisationId: org } })).map(
        (p) => p.id,
      );
      await db.shareLink.deleteMany({ where: { organisationId: org } });
      await db.videoRender.deleteMany({ where: { projectId: { in: ids } } });
      await db.videoProject.deleteMany({ where: { id: { in: ids } } });
      await db.systemFlag.deleteMany({
        where: { key: { in: [...ids, ...projectIds].map((id) => `studio.killedProject.${id}`) } },
      });
      await db.$disconnect();
    });

    it('runs the whole journey', async () => {
      const project = await db.videoProject.create({
        data: {
          organisationId: org,
          businessId: biz,
          createdByUserId: 'user-1',
          name: 'Spring menu',
          state: 'READY_FOR_REVIEW',
          sourceType: 'BRIEF',
          targetFormats: [],
        },
      });
      projectIds.push(project.id);
      const render = await db.videoRender.create({
        data: {
          projectId: project.id,
          scriptId: 's',
          targetPlatform: 'tiktok',
          aspectRatio: '9:16',
          resolution: '1080x1920',
          durationSec: 20,
          fps: 30,
          bitrateKbps: 4000,
          s3Bucket: 'renders',
          s3Key: `r/${randomUUID()}.mp4`,
          qualityCheckState: 'PASSED',
        },
      });
      await api.storage.put({
        bucket: 'renders',
        key: render.s3Key,
        body: new Uint8Array([1, 2]),
        contentType: 'video/mp4',
      });

      // 1. Share for feedback.
      const link = await call(shareLinksRoute.POST, {
        method: 'POST',
        params: { id: project.id },
        body: { expiresInHours: 72 },
        token: 'owner',
      });
      const token = (link.json.link as { url: string }).url.split('/p/')[1] as string;

      // 2. External reviewer: view + comment, no approval possible.
      const view = await call(publicRoute.GET, { params: { token } });
      expect(view.json).toMatchObject({ canApprove: false, variants: [{ platform: 'tiktok' }] });
      const comment = await call(publicCommentsRoute.POST, {
        method: 'POST',
        params: { token },
        body: { authorName: 'Client', body: 'Love the hook' },
      });
      expect(comment.status).toBe(201);
      expect(await db.videoProject.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({
        state: 'READY_FOR_REVIEW',
      });

      // 3. Export: the feedback is in it; the link token is not.
      const requested = await call(exportRoute.POST, {
        method: 'POST',
        body: { include: ['projects'] },
        token: 'owner',
      });
      const exportId = (requested.json.export as { id: string }).id;
      await runDataExport(
        {
          db,
          storage: api.storage,
          logger: pino({ level: 'silent' }),
          now: Date.now,
          assetsBucket: 'assets',
        },
        exportId,
      );
      const row = await db.dataExport.findUniqueOrThrow({ where: { id: exportId } });
      const zip = await api.storage.readRange(
        'assets',
        row.s3Key as string,
        0,
        (row.bytes as number) - 1,
      );
      const text = Object.values(unzipSync(zip))
        .map((f) => strFromU8(f))
        .join('\n');
      expect(text).toContain('Love the hook');
      expect(text).not.toContain(token);
      expect(text).not.toContain('tokenHash');

      // 4. Core deletes the business: the link stops working at once.
      const purge = await call(businessPurgeRoute.POST, {
        method: 'POST',
        params: { id: biz },
        body: { organisationId: org },
        headers: { 'x-service-token': SERVICE_TOKEN },
      });
      expect(purge.status).toBe(202);
      expect((await call(publicRoute.GET, { params: { token } })).status).toBe(404);

      // 5. After the grace, the sweep hard-deletes rows and files.
      // (The grace is moved into the past rather than the clock forward, so the sweep's other rules
      // never touch rows belonging to other suites.)
      await db.businessPurge.updateMany({
        where: { organisationId: org, businessId: biz },
        data: { graceUntil: new Date(Date.now() - DAY) },
      });
      await runRetentionSweep({
        db,
        storage: api.storage,
        logger: pino({ level: 'silent' }),
        audit: () => undefined,
        now: Date.now,
      });
      expect(await db.videoProject.findUnique({ where: { id: project.id } })).toBeNull();
      expect(await db.shareLink.count({ where: { projectId: project.id } })).toBe(0);
      await expect(api.storage.size('renders', render.s3Key)).rejects.toThrow();
      expect(
        await db.businessPurge.findFirstOrThrow({
          where: { organisationId: org, businessId: biz },
        }),
      ).toMatchObject({ state: 'hard_deleted' });
    });
  },
);
