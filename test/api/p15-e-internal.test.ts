import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fromContentRoute from '../../src/app/api/studio/internal/projects/from-content/route';
import * as businessPurgeRoute from '../../src/app/api/studio/internal/businesses/[id]/purge/route';
import * as attributeRoute from '../../src/app/api/studio/internal/publications/[id]/attribute-conversation/route';
import * as engagementRoute from '../../src/app/api/studio/analytics/engagement-conversations/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import type { CoreContentClient } from '../../src/lib/studio/core/content-client';
import { flagKeys } from '../../src/lib/studio/system-flags';
import { call, installApi, tenant } from '../helpers/api-harness';

// Phase 15 track E internal endpoints (X-Service-Token): 15.W1 from-content (501 until Core ships
// its content API; the Core-shipped path creates a DRAFT project), 15.E2 business purge, 15.E3
// attribute-conversation + the engagement report.

const hasDb = Boolean(process.env.DATABASE_URL);
const SERVICE_TOKEN = 's'.repeat(48);
const auth = { 'x-service-token': SERVICE_TOKEN };
const formats = [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 30 }];

describe.skipIf(!hasDb)('track E internal API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `p15e-int-${randomUUID()}`;
  const other = `p15e-int-other-${randomUUID()}`;
  const biz = `biz-${randomUUID()}`;
  // The from-content test creates a project in `biz`; the purge test uses its own business.
  const purgeBiz = `purge-${randomUUID()}`;
  let api: ReturnType<typeof installApi>;

  const project = (organisationId: string, businessId = biz, name = 'Spring menu') =>
    db.videoProject.create({
      data: {
        organisationId,
        businessId,
        createdByUserId: 'user-1',
        name,
        state: 'PUBLISHED',
        sourceType: 'BRIEF',
        targetFormats: [],
      },
    });
  const render = (projectId: string) =>
    db.videoRender.create({
      data: {
        projectId,
        scriptId: 's',
        targetPlatform: 'tiktok',
        aspectRatio: '9:16',
        resolution: '1080x1920',
        durationSec: 15,
        fps: 30,
        bitrateKbps: 4000,
        s3Bucket: 'renders',
        s3Key: `r/${randomUUID()}.mp4`,
        qualityCheckState: 'PASSED',
      },
    });
  const publication = async (organisationId: string, projectId: string, state = 'PUBLISHED') =>
    db.videoPublication.create({
      data: {
        organisationId,
        projectId,
        renderId: (await render(projectId)).id,
        platform: 'tiktok',
        platformAccountId: 'acct',
        state: state as 'PUBLISHED',
        publishedAt: state === 'PUBLISHED' ? new Date() : null,
        scheduledFor: state === 'SCHEDULED' ? new Date(Date.now() + 86_400_000) : null,
      },
    });

  beforeEach(() => {
    vi.stubEnv('STUDIO_INTERNAL_SERVICE_TOKEN', SERVICE_TOKEN);
    api = installApi(db, { owner: tenant(org), reader: tenant(org, ['studio:project:read']) });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    setApiDeps(undefined);
    const orgs = { in: [org, other] };
    const ids = (await db.videoProject.findMany({ where: { organisationId: orgs } })).map(
      (p) => p.id,
    );
    await db.publicationConversation.deleteMany({ where: { organisationId: orgs } });
    await db.scheduledPublication.deleteMany({
      where: {
        publicationId: {
          in: (await db.videoPublication.findMany({ where: { projectId: { in: ids } } })).map(
            (p) => p.id,
          ),
        },
      },
    });
    await db.videoPublication.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoRender.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoBrief.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.systemFlag.deleteMany({ where: { key: { in: ids.map(flagKeys.project) } } });
    await db.styleMemory.deleteMany({ where: { organisationId: orgs } });
    await db.platformConnection.deleteMany({ where: { organisationId: orgs } });
    await db.businessPurge.deleteMany({ where: { organisationId: orgs } });
    await db.$disconnect();
  });

  describe('POST /internal/projects/from-content (15.W1)', () => {
    const body = {
      organisationId: org,
      userId: 'user-1',
      businessId: biz,
      contentId: 'post_77',
      targetFormats: formats,
    };

    it('authenticates with X-Service-Token only and validates the body', async () => {
      expect(
        (await call(fromContentRoute.POST, { method: 'POST', body, token: 'owner' })).status,
      ).toBe(401);
      const bad = await call(fromContentRoute.POST, {
        method: 'POST',
        body: { organisationId: org },
        headers: auth,
      });
      expect(bad.status).toBe(400);
    });

    it('answers an honest 501 waiting for Core and creates nothing', async () => {
      const res = await call(fromContentRoute.POST, { method: 'POST', body, headers: auth });
      expect(res.status).toBe(501);
      expect(res.json).toEqual({
        ok: false,
        error: 'not_implemented',
        message: 'waiting for Core content API (GET /api/internal/content/:id)',
      });
      expect(
        await db.videoProject.count({ where: { organisationId: org, sourceRef: 'post_77' } }),
      ).toBe(0);
    });

    it('once Core ships: creates a DRAFT POSTMIND_CONTENT project and refuses foreign content', async () => {
      const content: CoreContentClient = {
        ready: true,
        getContent: vi.fn(async ({ contentId }) => ({
          id: contentId,
          organisationId: contentId === 'foreign' ? other : org,
          businessId: biz,
          kind: 'post' as const,
          title: 'Spring menu is here',
          text: 'New bakes every Friday',
          media: [],
          product: null,
        })),
      };
      setApiDeps({ ...api.deps, core: { content } });
      const res = await call(fromContentRoute.POST, { method: 'POST', body, headers: auth });
      expect(res.status).toBe(201);
      const created = await db.videoProject.findFirstOrThrow({
        where: { id: (res.json.project as { id: string }).id, organisationId: org },
      });
      expect(created).toMatchObject({
        state: 'DRAFT',
        sourceType: 'POSTMIND_CONTENT',
        sourceRef: 'post_77',
        businessId: biz,
      });
      expect(api.audits.at(-1)).toMatchObject({
        action: 'studio.project.create_from_content',
        actorUserId: 'system:postmind-core',
      });
      const foreign = await call(fromContentRoute.POST, {
        method: 'POST',
        body: { ...body, contentId: 'foreign' },
        headers: auth,
      });
      expect(foreign.status).toBe(404);
    });
  });

  describe('POST /internal/businesses/:id/purge (15.E2)', () => {
    it('soft-deletes and stops the business projects, cancels posts, wipes memory and tokens; idempotent', async () => {
      const mine = await project(org, purgeBiz);
      const otherBiz = await project(org, `keep-${randomUUID()}`);
      const scheduled = await publication(org, mine.id, 'SCHEDULED');
      await db.styleMemory.create({
        data: {
          organisationId: org,
          businessId: purgeBiz,
          signalType: 'SHOT_PACE',
          value: { summary: 'fast' },
          reason: 'r',
        },
      });
      await db.platformConnection.create({
        data: {
          organisationId: org,
          businessId: purgeBiz,
          platform: 'tiktok',
          platformAccountId: `t-${randomUUID()}`,
          platformAccountName: 'x',
          encryptedAccessToken: 'sealed-token',
          scopes: [],
          state: 'active',
          connectedByUserId: 'user-1',
        },
      });
      const params = { id: purgeBiz };
      expect(
        (await call(businessPurgeRoute.POST, { method: 'POST', params, body: {}, headers: auth }))
          .status,
      ).toBe(400);
      const res = await call(businessPurgeRoute.POST, {
        method: 'POST',
        params,
        body: { organisationId: org },
        headers: auth,
      });
      expect(res.status).toBe(202);
      expect(res.json.purge).toMatchObject({
        businessId: purgeBiz,
        projectsDeleted: 1,
        publicationsCancelled: 1,
        styleMemoriesDeleted: 1,
        channelsWiped: 1,
        repeated: false,
      });
      expect(JSON.stringify(res.json)).not.toContain('sealed-token');
      const purge = res.json.purge as { requestedAt: string; graceUntil: string };
      expect(Date.parse(purge.graceUntil) - Date.parse(purge.requestedAt)).toBe(30 * 86_400_000);
      expect(
        (await db.videoProject.findUniqueOrThrow({ where: { id: mine.id } })).deletedAt,
      ).not.toBeNull();
      expect(
        (await db.videoProject.findUniqueOrThrow({ where: { id: otherBiz.id } })).deletedAt,
      ).toBeNull();
      expect(
        (await db.systemFlag.findUnique({ where: { key: flagKeys.project(mine.id) } }))?.value,
      ).toBe('true');
      expect(
        (await db.videoPublication.findUniqueOrThrow({ where: { id: scheduled.id } })).state,
      ).toBe('CANCELLED');
      expect(api.audits.at(-1)).toMatchObject({
        action: 'studio.business.purge',
        organisationId: org,
      });
      const again = await call(businessPurgeRoute.POST, {
        method: 'POST',
        params,
        body: { organisationId: org },
        headers: auth,
      });
      expect(again.json.purge).toMatchObject({
        repeated: true,
        projectsDeleted: 0,
        graceUntil: purge.graceUntil,
      });
    });
  });

  describe('attribute-conversation + engagement report (15.E3)', () => {
    it('attributes idempotently, keeps isLead sticky, 404s another organisation, and reports', async () => {
      const p = await project(org, `rep-${randomUUID()}`, 'Hook project');
      await db.videoBrief.create({
        data: {
          projectId: p.id,
          rawInput: 'r',
          hook: 'Friday means sourdough',
          keyMessage: 'k',
          targetAudience: 'a',
          tone: 't',
          keywords: [],
          ideationModel: 'm',
        },
      });
      const pub = await publication(org, p.id);
      const theirs = await publication(other, (await project(other)).id);
      const post = (id: string, body: Record<string, unknown>) =>
        call(attributeRoute.POST, { method: 'POST', params: { id }, body, headers: auth });
      const first = await post(pub.id, {
        organisationId: org,
        conversationId: 'conv_1',
        kind: 'comment',
      });
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ attributed: true, repeated: false, isLead: false });
      const lead = await post(pub.id, {
        organisationId: org,
        conversationId: 'conv_1',
        isLead: true,
      });
      expect(lead.json).toMatchObject({ repeated: true, isLead: true });
      const notLead = await post(pub.id, {
        organisationId: org,
        conversationId: 'conv_1',
        isLead: false,
      });
      expect(notLead.json).toMatchObject({ isLead: true });
      await post(pub.id, { organisationId: org, conversationId: 'conv_2', kind: 'dm' });
      expect((await post(theirs.id, { organisationId: org, conversationId: 'x' })).status).toBe(
        404,
      );
      expect(
        (await post(pub.id, { organisationId: org, conversationId: 'x', kind: 'fax' })).status,
      ).toBe(400);
      expect(
        api.audits.filter((a) => a.action === 'studio.publication.attribute_conversation'),
      ).toHaveLength(2);

      expect(
        (
          await call(engagementRoute.GET, {
            path: '/api/studio/analytics/engagement-conversations',
          })
        ).status,
      ).toBe(401);
      const report = await call(engagementRoute.GET, {
        path: `/api/studio/analytics/engagement-conversations?days=30&businessId=${p.businessId}`,
        token: 'reader',
      });
      expect(report.status).toBe(200);
      expect(report.json.report).toMatchObject({
        totals: { publications: 1, conversations: 2, leads: 1 },
        byHook: [{ hook: 'Friday means sourdough', conversations: 2, leads: 1, leadRate: 0.5 }],
        byPlatform: [{ platform: 'tiktok', perPublication: 2 }],
      });
    });
  });
});
