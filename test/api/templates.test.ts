import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as approveRoute from '../../src/app/api/studio/projects/[id]/approve/route';
import * as projectRoute from '../../src/app/api/studio/projects/[id]/route';
import * as projectsRoute from '../../src/app/api/studio/projects/route';
import * as templateRoute from '../../src/app/api/studio/templates/[id]/route';
import * as templatesRoute from '../../src/app/api/studio/templates/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { INTRODUCE_YOURSELF, seedProjectTemplates } from '../../src/lib/studio/templates/seed';
import type { TenantContext } from '../../src/lib/tenant';
import { ALL_CAPABILITIES, call, installApi, tenant } from '../helpers/api-harness';

// Phase 12 automation (track A): project templates (spec 8.6), templates applied at project
// creation, auto-publish target validation, and REQUIRE_APPROVAL_FROM_ROLE on approve.

const hasDb = Boolean(process.env.DATABASE_URL);

type Template = {
  id: string;
  name: string;
  category: string;
  builtIn: boolean;
  organisationId: string | null;
  targetFormats: unknown;
  shotBlueprint: { shots: unknown[] };
  scriptTemplate: string;
  publishDefaults: { publishPolicy: string; reviewPolicy?: string; targets: unknown[] } | null;
};
type Project = {
  id: string;
  state: string;
  sourceType: string;
  description: string;
  targetFormats: unknown;
  publishPolicy: string;
  reviewPolicy: string;
  templateId: string | null;
  metadata: Record<string, unknown>;
};

describe.skipIf(!hasDb)('templates + automation API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `tpl-${randomUUID()}`;
  const otherOrg = `tpl-other-${randomUUID()}`;
  const member = (caps = ALL_CAPABILITIES): TenantContext => ({
    ...tenant(org, caps, 'user-member'),
    memberships: [{ organisationId: org, role: 'member' }],
  });
  const tokens = {
    owner: tenant(org),
    member: member(),
    editor: tenant(org, ['studio:project:read', 'studio:project:write']),
    reader: tenant(org, ['studio:project:read']),
    stranger: tenant(otherOrg),
  };
  let connectionId = '';
  let builtInId = '';

  const briefBody = (overrides: Record<string, unknown> = {}) => ({
    name: 'Launch',
    businessId: 'biz-1',
    brief: { rawInput: 'Launch our sourdough subscription' },
    targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 30 }],
    ...overrides,
  });
  const createProject = async (body: Record<string, unknown>, token = 'owner') =>
    call(projectsRoute.POST, { method: 'POST', token, body });

  beforeAll(async () => {
    await seedProjectTemplates(db);
    await seedProjectTemplates(db); // idempotent
    const builtIns = await db.template.findMany({
      where: { organisationId: null, name: INTRODUCE_YOURSELF.name },
    });
    expect(builtIns).toHaveLength(1);
    builtInId = builtIns[0]?.id ?? '';
    connectionId = (
      await db.platformConnection.create({
        data: {
          organisationId: org,
          businessId: 'biz-1',
          platform: 'tiktok',
          platformAccountId: `tt-${randomUUID()}`,
          platformAccountName: 'Sourdough',
          encryptedAccessToken: 'sealed',
          scopes: ['publish'],
          state: 'active',
          connectedByUserId: 'user-1',
        },
      })
    ).id;
  });
  beforeEach(() => {
    installApi(db, tokens);
  });
  afterAll(async () => {
    setApiDeps(undefined);
    const ids = (
      await db.videoProject.findMany({
        where: { organisationId: { in: [org, otherOrg] } },
        select: { id: true },
      })
    ).map((p) => p.id);
    await db.videoShot.deleteMany({ where: { script: { projectId: { in: ids } } } });
    await db.videoScript.deleteMany({ where: { projectId: { in: ids } } });
    await db.approvalTask.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.template.deleteMany({ where: { organisationId: { in: [org, otherOrg] } } });
    await db.platformConnection.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  describe('GET /templates', () => {
    it('lists the built-in "Introduce yourself" template with its publish defaults', async () => {
      const res = await call(templatesRoute.GET, { token: 'reader' });
      expect(res.status).toBe(200);
      const found = (res.json.data as Template[]).find((t) => t.id === builtInId);
      expect(found).toMatchObject({
        builtIn: true,
        category: 'introduction',
        publishDefaults: { publishPolicy: 'MANUAL', reviewPolicy: 'REQUIRE_APPROVAL', targets: [] },
      });
      expect(found?.shotBlueprint.shots).toHaveLength(5);
    });

    it('filters by category and validates it; 401 without a token', async () => {
      const res = await call(templatesRoute.GET, {
        token: 'reader',
        path: '/api/studio/templates?category=nothing_here',
      });
      expect(res.json.data).toEqual([]);
      const bad = await call(templatesRoute.GET, {
        token: 'reader',
        path: '/api/studio/templates?category=Bad%20Cat',
      });
      expect(bad.status).toBe(400);
      expect((await call(templatesRoute.GET, {})).status).toBe(401);
    });

    it('GET /templates/:id returns built-ins and 404s for unknown ids', async () => {
      const res = await call(templateRoute.GET, { token: 'reader', params: { id: builtInId } });
      expect((res.json.template as Template).name).toBe(INTRODUCE_YOURSELF.name);
      expect(
        (await call(templateRoute.GET, { token: 'reader', params: { id: 'nope' } })).status,
      ).toBe(404);
    });
  });

  describe('POST /templates (save a project as a template)', () => {
    async function generatedProject() {
      const res = await createProject(
        briefBody({
          publishPolicy: 'AUTO_ON_APPROVAL',
          reviewPolicy: 'AUTO_APPROVE',
          autoPublish: { targets: [{ platform: 'tiktok', connectionId, caption: 'New!' }] },
        }),
      );
      const id = (res.json.project as Project).id;
      await db.videoScript.create({
        data: {
          projectId: id,
          targetPlatform: 'tiktok',
          targetAspectRatio: '9:16',
          targetDurationSec: 30,
          fullText: 'Secret words',
          scriptModel: 'test',
          shots: {
            create: [
              {
                sortOrder: 0,
                durationSec: 3,
                visualTreatment: 'IMAGE_STILL',
                sceneDescription: 'Loaf',
                onScreenText: 'Secret words',
                state: 'READY',
              },
              {
                sortOrder: 1,
                durationSec: 27,
                visualTreatment: 'AI_CLIP',
                sceneDescription: 'Baker',
                voiceoverText: 'Secret words',
                state: 'READY',
              },
            ],
          },
        },
      });
      return id;
    }

    it('saves the shape, policies and targets; org-scoped; deletable by its org only', async () => {
      const projectId = await generatedProject();
      const res = await call(templatesRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: { projectId, name: 'Weekly launch', category: 'launches' },
      });
      expect(res.status).toBe(201);
      const template = res.json.template as Template;
      expect(template).toMatchObject({
        organisationId: org,
        builtIn: false,
        category: 'launches',
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 30 }],
        publishDefaults: {
          publishPolicy: 'AUTO_ON_APPROVAL',
          reviewPolicy: 'AUTO_APPROVE',
          targets: [{ platform: 'tiktok', connectionId, caption: 'New!' }],
        },
      });
      expect(template.shotBlueprint.shots).toHaveLength(2);
      expect(JSON.stringify(template.shotBlueprint)).not.toContain('Secret words');

      // Isolation: invisible to another organisation, which can neither read nor delete it.
      const strangerList = await call(templatesRoute.GET, { token: 'stranger' });
      expect((strangerList.json.data as Template[]).some((t) => t.id === template.id)).toBe(false);
      expect(
        (await call(templateRoute.GET, { token: 'stranger', params: { id: template.id } })).status,
      ).toBe(404);
      expect(
        (
          await call(templateRoute.DELETE, {
            method: 'DELETE',
            token: 'stranger',
            params: { id: template.id },
          })
        ).status,
      ).toBe(404);

      expect(
        (
          await call(templateRoute.DELETE, {
            method: 'DELETE',
            token: 'reader',
            params: { id: template.id },
          })
        ).status,
      ).toBe(403);
      const deleted = await call(templateRoute.DELETE, {
        method: 'DELETE',
        token: 'owner',
        params: { id: template.id },
      });
      expect(deleted.status).toBe(200);
      expect(await db.template.findUnique({ where: { id: template.id } })).toBeNull();
    });

    it('refuses to delete built-ins, to save un-generated projects, and targets without publish rights', async () => {
      expect(
        (
          await call(templateRoute.DELETE, {
            method: 'DELETE',
            token: 'owner',
            params: { id: builtInId },
          })
        ).status,
      ).toBe(403);
      const draft = (await createProject(briefBody())).json.project as Project;
      const unsaved = await call(templatesRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: { projectId: draft.id, name: 'Nope' },
      });
      expect(unsaved.status).toBe(400);

      const projectId = await generatedProject();
      const noPublish = await call(templatesRoute.POST, {
        method: 'POST',
        token: 'editor',
        body: { projectId, name: 'Targets' },
      });
      expect(noPublish.status).toBe(403);
      const withoutDefaults = await call(templatesRoute.POST, {
        method: 'POST',
        token: 'editor',
        body: { projectId, name: 'Shape only', includePublishDefaults: false },
      });
      expect(withoutDefaults.status).toBe(201);
      expect((withoutDefaults.json.template as Template).publishDefaults).toBeNull();
    });
  });

  describe('POST /projects with a template', () => {
    it('inherits formats, review/publish defaults and the rendered outline', async () => {
      const res = await createProject({
        name: 'Hello',
        businessId: 'biz-1',
        sourceType: 'TEMPLATE',
        templateId: builtInId,
        brief: { rawInput: 'We are Leeds Sourdough, a family bakery.' },
      });
      expect(res.status).toBe(201);
      const project = res.json.project as Project;
      expect(project).toMatchObject({
        sourceType: 'TEMPLATE',
        templateId: builtInId,
        publishPolicy: 'MANUAL',
        reviewPolicy: 'REQUIRE_APPROVAL',
        targetFormats: INTRODUCE_YOURSELF.targetFormats,
        metadata: expect.objectContaining({ template: { id: builtInId } }),
      });
      expect(project.description).toContain('We are Leeds Sourdough, a family bakery.');
      expect(project.description).toContain('Introduce the business');
    });

    it('inherits an org template’s auto-publish targets (dropping unrendered platforms)', async () => {
      const template = await db.template.create({
        data: {
          organisationId: org,
          name: 'Auto',
          category: 'custom',
          targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 15 }],
          scriptTemplate: '{{brief}}',
          shotBlueprint: INTRODUCE_YOURSELF.shotBlueprint as never,
          publishDefaults: {
            publishPolicy: 'AUTO_ON_APPROVAL',
            reviewPolicy: 'AUTO_APPROVE',
            targets: [
              { platform: 'tiktok', connectionId },
              { platform: 'facebook', platformAccountId: 'fb-1' },
            ],
          },
        },
      });
      const res = await createProject({
        name: 'From template',
        businessId: 'biz-1',
        sourceType: 'TEMPLATE',
        templateId: template.id,
        brief: { rawInput: 'Weekend special' },
      });
      expect(res.status).toBe(201);
      expect(res.json.project).toMatchObject({
        publishPolicy: 'AUTO_ON_APPROVAL',
        reviewPolicy: 'AUTO_APPROVE',
        description: 'Weekend special',
        metadata: expect.objectContaining({
          autoPublish: { targets: [{ platform: 'tiktok', connectionId }] },
        }),
      });
      // Another organisation cannot build from it; a template project without a brief needs an outline.
      expect(
        (
          await createProject(
            {
              name: 'x',
              businessId: 'biz-1',
              sourceType: 'TEMPLATE',
              templateId: template.id,
              brief: { rawInput: 'x' },
            },
            'stranger',
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await createProject({
            name: 'x',
            businessId: 'biz-1',
            sourceType: 'TEMPLATE',
            templateId: template.id,
          })
        ).status,
      ).toBe(400);
      // Inherited targets still need publication rights.
      expect(
        (
          await createProject(
            {
              name: 'x',
              businessId: 'biz-1',
              sourceType: 'TEMPLATE',
              templateId: template.id,
              brief: { rawInput: 'x' },
            },
            'editor',
          )
        ).status,
      ).toBe(403);
    });

    it('requires templateId for TEMPLATE and formats otherwise', async () => {
      expect(
        (await createProject({ name: 'x', businessId: 'b', sourceType: 'TEMPLATE' })).status,
      ).toBe(400);
      expect(
        (await createProject({ name: 'x', businessId: 'b', brief: { rawInput: 'x' } })).status,
      ).toBe(400);
    });
  });

  describe('auto-publish targets on create / update', () => {
    it('rejects targets for other platforms or foreign connections', async () => {
      const wrongPlatform = await createProject(
        briefBody({ autoPublish: { targets: [{ platform: 'x', connectionId }] } }),
      );
      expect(wrongPlatform.status).toBe(400);
      const foreign = await createProject(
        briefBody({ autoPublish: { targets: [{ platform: 'tiktok', connectionId: 'other' }] } }),
      );
      expect(foreign.status).toBe(400);
      expect(
        (
          await createProject(
            briefBody({ autoPublish: { targets: [{ platform: 'tiktok', connectionId }] } }),
            'editor',
          )
        ).status,
      ).toBe(403);
    });

    it('PATCH stores targets (with publication rights) and replaces them', async () => {
      const id = ((await createProject(briefBody())).json.project as Project).id;
      const targets = [{ platform: 'tiktok', connectionId, scheduleOffsetMinutes: 30 }];
      const res = await call(projectRoute.PATCH, {
        method: 'PATCH',
        token: 'owner',
        params: { id },
        body: { publishPolicy: 'AUTO_ON_APPROVAL', autoPublish: { targets } },
      });
      expect(res.status).toBe(200);
      expect(res.json.project).toMatchObject({
        publishPolicy: 'AUTO_ON_APPROVAL',
        metadata: expect.objectContaining({ autoPublish: { targets } }),
      });
      const denied = await call(projectRoute.PATCH, {
        method: 'PATCH',
        token: 'editor',
        params: { id },
        body: { autoPublish: { targets } },
      });
      expect(denied.status).toBe(403);
      // Re-arming auto-publish over stored targets needs the same capability.
      await call(projectRoute.PATCH, {
        method: 'PATCH',
        token: 'owner',
        params: { id },
        body: { publishPolicy: 'MANUAL' },
      });
      const rearm = await call(projectRoute.PATCH, {
        method: 'PATCH',
        token: 'editor',
        params: { id },
        body: { publishPolicy: 'AUTO_ON_APPROVAL' },
      });
      expect(rearm.status).toBe(403);
    });
  });

  describe('POST /projects/:id/approve with REQUIRE_APPROVAL_FROM_ROLE', () => {
    async function reviewable(reviewPolicy: string) {
      const id = ((await createProject(briefBody({ reviewPolicy }))).json.project as Project).id;
      await db.videoProject.update({ where: { id }, data: { state: 'READY_FOR_REVIEW' } });
      return id;
    }

    it('needs an owner/admin approver; records the required role', async () => {
      const id = await reviewable('REQUIRE_APPROVAL_FROM_ROLE');
      const refused = await call(approveRoute.POST, {
        method: 'POST',
        token: 'member',
        params: { id },
      });
      expect(refused.status).toBe(403);
      expect((await db.videoProject.findUniqueOrThrow({ where: { id } })).state).toBe(
        'READY_FOR_REVIEW',
      );
      const ok = await call(approveRoute.POST, { method: 'POST', token: 'owner', params: { id } });
      expect(ok.status).toBe(200);
      expect(ok.json.autoPublish).toMatchObject({ status: 'skipped' });
      const [task] = await db.approvalTask.findMany({ where: { projectId: id } });
      expect(task).toMatchObject({
        state: 'APPROVED',
        requiredRole: 'owner|admin',
        resolvedByUserId: 'user-1',
      });
    });

    it('lets any approver approve REQUIRE_APPROVAL projects', async () => {
      const id = await reviewable('REQUIRE_APPROVAL');
      const ok = await call(approveRoute.POST, { method: 'POST', token: 'member', params: { id } });
      expect(ok.status).toBe(200);
    });

    it('AUTO_ON_APPROVAL with no targets approves and records "no targets"', async () => {
      // 20.12: the API refuses to create one (auto_publish_account_required); a row stored
      // before that rule (or edited directly) still approves cleanly.
      const refused = await createProject(briefBody({ publishPolicy: 'AUTO_ON_APPROVAL' }));
      expect(refused.status).toBe(400);
      expect(refused.json.error).toBe('auto_publish_account_required');
      const id = ((await createProject(briefBody())).json.project as Project).id;
      await db.videoProject.update({
        where: { id },
        data: { state: 'READY_FOR_REVIEW', publishPolicy: 'AUTO_ON_APPROVAL' },
      });
      const ok = await call(approveRoute.POST, { method: 'POST', token: 'owner', params: { id } });
      expect(ok.status).toBe(200);
      expect(ok.json.autoPublish).toMatchObject({ status: 'no_targets', results: [] });
      const stored = await db.videoProject.findUniqueOrThrow({ where: { id } });
      expect((stored.metadata as Record<string, unknown>).autoPublishResult).toMatchObject({
        status: 'no_targets',
        trigger: 'human',
      });
    });
  });
});
