import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { strFromU8, unzipSync } from 'fflate';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as shareLinksRoute from '../../src/app/api/studio/projects/[id]/share-links/route';
import * as shareLinkRoute from '../../src/app/api/studio/projects/[id]/share-links/[linkId]/route';
import * as publicRoute from '../../src/app/api/studio/public/share-links/[token]/route';
import * as publicCommentsRoute from '../../src/app/api/studio/public/share-links/[token]/comments/route';
import * as exportRoute from '../../src/app/api/studio/account/export/route';
import * as exportItemRoute from '../../src/app/api/studio/account/export/[id]/route';
import * as slideshowTemplateRoute from '../../src/app/api/studio/slideshow-templates/[id]/route';
import * as styleMemoryRoute from '../../src/app/api/studio/businesses/[id]/style-memory/[memoryId]/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { createMemoryRateLimitStore, createRateLimiter } from '../../src/lib/studio/api/rate-limit';
import { runDataExport } from '../../src/lib/studio/services/export';
import { styleMemorySupplement } from '../../src/lib/studio/services/style-memory';
import { call, installApi, tenant } from '../helpers/api-harness';

// Phase 15 track E user-facing APIs: 15.E5 share links (+ decision P8 feedback, no approval),
// 15.E1 account export, 15.E7 slideshow-template delete, 15.E6 style-memory edit.

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('track E sharing, export and editing APIs', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `p15e-share-${randomUUID()}`;
  const other = `p15e-share-other-${randomUUID()}`;
  const biz = `biz-${randomUUID()}`;
  let api: ReturnType<typeof installApi>;
  const tokens = {
    owner: tenant(org),
    reader: tenant(org, ['studio:project:read']),
    outsider: tenant(other),
  };

  const project = (organisationId = org, name = 'Spring menu') =>
    db.videoProject.create({
      data: {
        organisationId,
        businessId: biz,
        createdByUserId: 'user-1',
        name,
        state: 'READY_FOR_REVIEW',
        sourceType: 'BRIEF',
        targetFormats: [],
      },
    });

  beforeEach(() => {
    api = installApi(db, tokens);
  });

  afterAll(async () => {
    setApiDeps(undefined);
    const orgs = { in: [org, other] };
    const ids = (await db.videoProject.findMany({ where: { organisationId: orgs } })).map(
      (p) => p.id,
    );
    await db.shareLink.deleteMany({ where: { organisationId: orgs } });
    await db.videoRender.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.dataExport.deleteMany({ where: { organisationId: orgs } });
    await db.platformConnection.deleteMany({ where: { organisationId: orgs } });
    await db.notification.deleteMany({ where: { organisationId: orgs } });
    await db.slideshowTemplate.deleteMany({ where: { organisationId: orgs } });
    await db.styleMemory.deleteMany({ where: { organisationId: orgs } });
    await db.$disconnect();
  });

  describe('share links (15.E5, decision P8)', () => {
    it('creates, lists, serves publicly, takes feedback, notifies and revokes', async () => {
      const p = await project(org, 'مرحبا — 春のメニュー — वसंत');
      await db.videoRender.create({
        data: {
          projectId: p.id,
          scriptId: 's',
          targetPlatform: 'tiktok',
          aspectRatio: '9:16',
          resolution: '1080x1920',
          durationSec: 15,
          fps: 30,
          bitrateKbps: 4000,
          s3Bucket: 'renders',
          s3Key: 'r/1.mp4',
          qualityCheckState: 'PASSED',
        },
      });
      const params = { id: p.id };
      expect(
        (await call(shareLinksRoute.POST, { method: 'POST', params, body: {}, token: 'reader' }))
          .status,
      ).toBe(403);
      expect(
        (await call(shareLinksRoute.POST, { method: 'POST', params, body: {}, token: 'outsider' }))
          .status,
      ).toBe(404);
      expect(
        (
          await call(shareLinksRoute.POST, {
            method: 'POST',
            params,
            body: { expiresInHours: 169 },
            token: 'owner',
          })
        ).status,
      ).toBe(400);
      const created = await call(shareLinksRoute.POST, {
        method: 'POST',
        params,
        body: { expiresInHours: 72 },
        token: 'owner',
      });
      expect(created.status).toBe(201);
      const link = created.json.link as { id: string; url: string; expiresAt: string };
      expect(link.url).toMatch(/^http:\/\/studio\.test\/p\/[A-Za-z0-9_-]{43}$/);
      const token = link.url.split('/p/')[1] as string;
      const row = await db.shareLink.findUniqueOrThrow({ where: { id: link.id } });
      expect(row.tokenHash).not.toContain(token);
      expect(api.audits.at(-1)).toMatchObject({ action: 'studio.share_link.create' });

      const view = await call(publicRoute.GET, { params: { token } });
      expect(view.status).toBe(200);
      expect(view.headers.get('cache-control')).toBe('no-store');
      expect(view.headers.get('referrer-policy')).toBe('no-referrer');
      expect(view.json).toMatchObject({
        project: { name: 'مرحبا — 春のメニュー — वसंत' },
        variants: [{ platform: 'tiktok', videoUrl: expect.stringContaining('https://') }],
        canApprove: false,
      });
      expect(JSON.stringify(view.json)).not.toContain(org);

      const comment = await call(publicCommentsRoute.POST, {
        method: 'POST',
        params: { token },
        body: {
          authorName: 'سارة',
          authorEmail: 'sara@example.com',
          body: 'رائع! 很好 बहुत अच्छा',
        },
      });
      expect(comment.status).toBe(201);
      expect(
        (
          await call(publicCommentsRoute.POST, {
            method: 'POST',
            params: { token },
            body: { authorName: 'x', body: 'y', approve: true },
          })
        ).status,
      ).toBe(400);
      expect(api.audits.at(-1)).toMatchObject({
        action: 'studio.share_link.comment',
        organisationId: org,
        actorUserId: 'external:share-link',
      });
      const note = await db.notification.findFirst({
        where: { organisationId: org, kind: 'share_comment' },
      });
      expect(note).toMatchObject({ userId: 'user-1', link: `/projects/${p.id}` });

      const listed = await call(shareLinksRoute.GET, { params, token: 'reader' });
      expect(listed.json.data).toMatchObject([
        {
          id: link.id,
          state: 'active',
          viewCount: 1,
          comments: [{ authorName: 'سارة', authorEmail: 'sara@example.com' }],
        },
      ]);
      expect(JSON.stringify(listed.json)).not.toContain(token);
      // The public page never shows the reviewer's email.
      expect(
        JSON.stringify((await call(publicRoute.GET, { params: { token } })).json),
      ).not.toContain('sara@');

      expect(
        (
          await call(shareLinkRoute.DELETE, {
            method: 'DELETE',
            params: { id: p.id, linkId: link.id },
            token: 'outsider',
          })
        ).status,
      ).toBe(404);
      const revoked = await call(shareLinkRoute.DELETE, {
        method: 'DELETE',
        params: { id: p.id, linkId: link.id },
        token: 'owner',
      });
      expect(revoked.status).toBe(200);
      const gone = await call(publicRoute.GET, { params: { token } });
      expect(gone.status).toBe(404);
      expect(gone.json.message).toBe('This preview link is invalid or has expired');
    });

    it('unknown, malformed and expired tokens are the same 404; public requests are rate limited', async () => {
      const p = await project();
      const unknown = await call(publicRoute.GET, { params: { token: 'a'.repeat(43) } });
      const malformed = await call(publicRoute.GET, { params: { token: '../etc' } });
      expect([unknown.status, malformed.status]).toEqual([404, 404]);
      expect(unknown.json).toEqual(malformed.json);
      const created = await call(shareLinksRoute.POST, {
        method: 'POST',
        params: { id: p.id },
        body: { expiresInHours: 1 },
        token: 'owner',
      });
      const token = (created.json.link as { url: string }).url.split('/p/')[1] as string;
      await db.shareLink.updateMany({
        where: { projectId: p.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect((await call(publicRoute.GET, { params: { token } })).json).toEqual(unknown.json);

      setApiDeps({
        ...api.deps,
        publicRateLimiter: createRateLimiter(createMemoryRateLimitStore(), {
          readsPerMin: 2,
          writesPerMin: 1,
          orgPerMin: 100,
        }),
      });
      const t = 'b'.repeat(43);
      const statuses = [];
      for (let i = 0; i < 3; i += 1)
        statuses.push((await call(publicRoute.GET, { params: { token: t } })).status);
      expect(statuses).toEqual([404, 404, 429]);
    });
  });

  describe('account export (15.E1)', () => {
    it('queues one export at a time, builds a scoped ZIP without tokens, and signs a link', async () => {
      await project(org, 'Exported project');
      await project(other, 'Not mine');
      await db.platformConnection.create({
        data: {
          organisationId: org,
          platform: 'tiktok',
          platformAccountId: `t-${randomUUID()}`,
          platformAccountName: 'acct',
          encryptedAccessToken: 'sealed-access-token',
          encryptedRefreshToken: 'sealed-refresh-token',
          scopes: [],
          state: 'active',
          connectedByUserId: 'user-1',
        },
      });
      expect(
        (
          await call(exportRoute.POST, {
            method: 'POST',
            body: { include: ['nope'] },
            token: 'owner',
          })
        ).status,
      ).toBe(400);
      expect(
        (await call(exportRoute.POST, { method: 'POST', body: {}, token: 'reader' })).status,
      ).toBe(403);
      const res = await call(exportRoute.POST, {
        method: 'POST',
        body: { include: ['projects', 'brand'] },
        token: 'owner',
      });
      expect(res.status).toBe(202);
      const exp = res.json.export as { id: string; state: string };
      expect(exp.state).toBe('QUEUED');
      expect(api.queue.pending.at(-1)).toMatchObject({
        name: 'export-account-data',
        data: { exportId: exp.id },
      });
      expect(
        (await call(exportRoute.POST, { method: 'POST', body: {}, token: 'owner' })).status,
      ).toBe(409);

      await runDataExport(
        {
          db,
          storage: api.storage,
          logger: pino({ level: 'silent' }),
          now: Date.now,
          assetsBucket: 'assets',
        },
        exp.id,
      );
      const got = await call(exportItemRoute.GET, { params: { id: exp.id }, token: 'owner' });
      expect(got.json.export).toMatchObject({
        state: 'READY',
        downloadUrl: expect.stringContaining('exports/'),
      });
      expect(
        (await call(exportItemRoute.GET, { params: { id: exp.id }, token: 'outsider' })).status,
      ).toBe(404);
      const row = await db.dataExport.findUniqueOrThrow({ where: { id: exp.id } });
      expect(row.activeKey).toBeNull();
      expect(row.expiresAt!.getTime() - row.completedAt!.getTime()).toBe(7 * 86_400_000);

      const zip = await api.storage.readRange(
        'assets',
        row.s3Key as string,
        0,
        (row.bytes as number) - 1,
      );
      const files = unzipSync(zip);
      const text = Object.values(files)
        .map((f) => strFromU8(f))
        .join('\n');
      expect(text).toContain('Exported project');
      expect(text).not.toContain('Not mine');
      expect(text).not.toContain('sealed-access-token');
      expect(text).not.toContain('sealed-refresh-token');
      expect(Object.keys(files)).toEqual(
        expect.arrayContaining([
          'manifest.json',
          'assets.json',
          'tables/video_projects.json',
          'tables/platform_connections.json',
          'tables/brand_kits.json',
        ]),
      );
      expect(Object.keys(files)).not.toContain('tables/image_library.json');
      // A new export is allowed once the first finished.
      expect(
        (await call(exportRoute.POST, { method: 'POST', body: {}, token: 'owner' })).status,
      ).toBe(202);
      const list = await call(exportRoute.GET, { token: 'reader' });
      expect((list.json.data as unknown[]).length).toBe(2);
    });
  });

  describe('slideshow template delete (15.E7)', () => {
    it('deletes own templates, refuses built-ins and hides other organisations', async () => {
      const mine = await db.slideshowTemplate.create({
        data: { organisationId: org, name: 'Mine', category: 'custom', slidePlan: [] },
      });
      const theirs = await db.slideshowTemplate.create({
        data: { organisationId: other, name: 'Theirs', category: 'custom', slidePlan: [] },
      });
      const builtIn = await db.slideshowTemplate.findFirst({ where: { organisationId: null } });
      const del = (id: string, token = 'owner') =>
        call(slideshowTemplateRoute.DELETE, { method: 'DELETE', params: { id }, token });
      expect((await del(mine.id, 'reader')).status).toBe(403);
      expect((await del(theirs.id)).status).toBe(404);
      if (builtIn) expect((await del(builtIn.id)).status).toBe(403);
      expect((await del(mine.id)).status).toBe(200);
      expect(await db.slideshowTemplate.findUnique({ where: { id: mine.id } })).toBeNull();
      expect(api.audits.at(-1)).toMatchObject({ action: 'studio.slideshow_template.delete' });
    });
  });

  describe('style memory edit (15.E6)', () => {
    it('edits pin the memory, disable removes it from prompts, and other orgs 404', async () => {
      const m = await db.styleMemory.create({
        data: {
          organisationId: org,
          businessId: biz,
          signalType: 'POSTING_TIME',
          value: { summary: 'Tuesday 8am', hour: 8 },
          weight: 0.9,
          reason: 'r',
        },
      });
      const patch = (body: unknown, token = 'owner') =>
        call(styleMemoryRoute.PATCH, {
          method: 'PATCH',
          params: { id: biz, memoryId: m.id },
          body,
          token,
        });
      expect((await patch({})).status).toBe(400);
      expect((await patch({ value: 'x' }, 'outsider')).status).toBe(404);
      const edited = await patch({ value: 'Friday 7am' });
      expect(edited.status).toBe(200);
      expect(edited.json.memory).toMatchObject({
        value: 'Friday 7am',
        pinned: true,
        disabled: false,
        details: { hour: 8 },
      });
      expect(await styleMemorySupplement(db, org, biz)).toContain('Friday 7am');
      expect((await patch({ disabled: true })).json.memory).toMatchObject({
        disabled: true,
        pinned: true,
      });
      expect(await styleMemorySupplement(db, org, biz)).toBeNull();
      expect(api.audits.at(-1)).toMatchObject({
        action: 'studio.style_memory.update',
        metadata: expect.objectContaining({ disabled: true }),
      });
      vi.clearAllMocks();
    });
  });
});
