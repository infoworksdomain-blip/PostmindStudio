import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as projectRendersRoute from '../../src/app/api/studio/projects/[id]/renders/route';
import * as projectScriptsRoute from '../../src/app/api/studio/projects/[id]/scripts/route';
import * as downloadRoute from '../../src/app/api/studio/renders/[id]/download/route';
import * as forceApproveRoute from '../../src/app/api/studio/renders/[id]/force-approve/route';
import * as previewRoute from '../../src/app/api/studio/renders/[id]/preview/route';
import * as renderRoute from '../../src/app/api/studio/renders/[id]/route';
import * as scriptRoute from '../../src/app/api/studio/scripts/[id]/route';
import * as regenerateRoute from '../../src/app/api/studio/shots/[id]/regenerate/route';
import * as shotRoute from '../../src/app/api/studio/shots/[id]/route';
import { GET as health } from '../../src/app/api/health/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { call, installApi, tenant } from '../helpers/api-harness';

// BACKLOG 4.9 + 4.10: script, shot and render routes, and force-approve (spec 13.5).

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('script, shot and render API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-sr-${randomUUID()}`;
  const tokens = {
    owner: tenant(org),
    reader: tenant(org, ['studio:project:read']),
    stranger: tenant(`api-sr-other-${randomUUID()}`),
  };
  let api: ReturnType<typeof installApi>;

  beforeEach(() => {
    api = installApi(db, tokens);
  });

  afterAll(async () => {
    setApiDeps(undefined);
    const ids = (
      await db.videoProject.findMany({ where: { organisationId: org }, select: { id: true } })
    ).map((p) => p.id);
    await db.videoShot.deleteMany({ where: { script: { projectId: { in: ids } } } });
    await db.videoScript.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoRender.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  /** A finished project: one script, two shots, one render with a given quality result. */
  async function finishedProject(
    checks: Array<{ code: string; status: string; severity: string; detail: string }>,
  ) {
    const runId = randomUUID();
    const project = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId: 'biz',
        createdByUserId: 'user-1',
        name: 'Done',
        state: checks.some((c) => c.status === 'failed') ? 'QUALITY_FAILED' : 'READY_FOR_REVIEW',
        sourceType: 'BRIEF',
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 10 }],
        metadata: { runId },
      },
    });
    const script = await db.videoScript.create({
      data: {
        projectId: project.id,
        targetPlatform: 'tiktok',
        targetAspectRatio: '9:16',
        targetDurationSec: 10,
        fullText: 'Hello there.',
        scriptModel: 'anthropic:test',
        shots: {
          create: [
            {
              sortOrder: 0,
              durationSec: 5,
              visualTreatment: 'AI_CLIP',
              sceneDescription: 'bread',
              voiceoverText: 'Hello',
              state: 'READY',
              assetId: 'asset-1',
              voiceAssetId: 'voice-1',
            },
            {
              sortOrder: 1,
              durationSec: 5,
              visualTreatment: 'TEXT_CARD',
              sceneDescription: 'card',
              onScreenText: 'Subscribe',
              state: 'READY',
            },
          ],
        },
      },
      include: { shots: { orderBy: { sortOrder: 'asc' } } },
    });
    const render = await db.videoRender.create({
      data: {
        projectId: project.id,
        scriptId: script.id,
        targetPlatform: 'tiktok',
        aspectRatio: '9:16',
        resolution: '1080x1920',
        durationSec: 10,
        fps: 30,
        bitrateKbps: 4000,
        s3Bucket: 'renders',
        s3Key: `orgs/${org}/r.mp4`,
        qualityCheckState: checks.some((c) => c.status === 'failed') ? 'FAILED' : 'PASSED',
        qualityIssues: checks,
      },
    });
    await db.videoProject.update({
      where: { id: project.id },
      data: { metadata: { runId, renders: { [script.id]: render.id } } },
    });
    return { project, script, shots: script.shots, render };
  }

  const passed = [{ code: 'duration_match', status: 'passed', severity: 'error', detail: 'ok' }];
  const loudnessFailed = [
    { code: 'audio_present', status: 'failed', severity: 'error', detail: '-25 LUFS' },
  ];
  const safetyBlocked = [
    {
      code: 'content_safety',
      status: 'failed',
      severity: 'block',
      detail: 'Blocked: yes_nazi=0.95',
    },
  ];

  it('health is public', async () => {
    const res = health();
    expect(res.status).toBe(200);
  });

  it('lists scripts and reads a script and shot (tenant-scoped)', async () => {
    const { project, script, shots } = await finishedProject(passed);
    const list = await call(projectScriptsRoute.GET, {
      token: 'reader',
      params: { id: project.id },
    });
    expect(list.status).toBe(200);
    expect(list.json.data).toHaveLength(1);
    const one = await call(scriptRoute.GET, { token: 'reader', params: { id: script.id } });
    expect((one.json.script as { shots: unknown[] }).shots).toHaveLength(2);
    const shot = await call(shotRoute.GET, { token: 'reader', params: { id: shots[0]!.id } });
    expect(shot.json.shot).toMatchObject({ id: shots[0]!.id, assets: [] });
    for (const [route, id] of [
      [scriptRoute.GET, script.id],
      [shotRoute.GET, shots[0]!.id],
      [projectScriptsRoute.GET, project.id],
    ] as const) {
      expect((await call(route, { token: 'stranger', params: { id } })).status).toBe(404);
      expect((await call(route, { params: { id } })).status).toBe(401);
    }
  });

  it('editing narration starts a voice-only run for that shot', async () => {
    const { project, shots } = await finishedProject(passed);
    const res = await call(shotRoute.PATCH, {
      method: 'PATCH',
      token: 'owner',
      params: { id: shots[0]!.id },
      body: { voiceoverText: 'Good morning' },
    });
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ voiceRegenerated: true });
    const shot = await db.videoShot.findUniqueOrThrow({ where: { id: shots[0]!.id } });
    expect(shot).toMatchObject({
      voiceoverText: 'Good morning',
      voiceAssetId: null,
      assetId: 'asset-1',
      state: 'QUEUED',
    });
    const updated = await db.videoProject.findUniqueOrThrow({ where: { id: project.id } });
    expect(updated.state).toBe('ASSETS_QUEUED');
    expect(api.queue.history.at(-1)).toMatchObject({
      name: 'generate-asset',
      data: { shotId: shots[0]!.id, runId: res.json.runId },
    });
    expect((updated.metadata as { renders: object }).renders).toEqual({});
    // Now generating: further edits conflict.
    expect(
      (
        await call(shotRoute.PATCH, {
          method: 'PATCH',
          token: 'owner',
          params: { id: shots[1]!.id },
          body: { onScreenText: 'x' },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(shotRoute.PATCH, {
          method: 'PATCH',
          token: 'owner',
          params: { id: shots[1]!.id },
          body: {},
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(shotRoute.PATCH, {
          method: 'PATCH',
          token: 'reader',
          params: { id: shots[1]!.id },
          body: { onScreenText: 'x' },
        })
      ).status,
    ).toBe(403);
  });

  it('regenerating a shot clears its visual and records the preferred provider', async () => {
    const { shots } = await finishedProject(passed);
    const res = await call(regenerateRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: shots[0]!.id },
      body: { prompt: 'Croissants instead', providerId: 'runway' },
    });
    expect(res.status).toBe(202);
    const shot = await db.videoShot.findUniqueOrThrow({ where: { id: shots[0]!.id } });
    expect(shot).toMatchObject({
      assetId: null,
      voiceAssetId: 'voice-1',
      sceneDescription: 'Croissants instead',
      state: 'QUEUED',
    });
    expect(shot.providerRouting).toMatchObject({ preferredProviderId: 'runway' });
    expect(
      (
        await call(regenerateRoute.POST, {
          method: 'POST',
          token: 'stranger',
          params: { id: shots[0]!.id },
          body: {},
        })
      ).status,
    ).toBe(404);
  });

  it('lists and reads renders; preview and download return signed URLs; download needs its capability', async () => {
    const { project, render } = await finishedProject(passed);
    expect(
      (await call(projectRendersRoute.GET, { token: 'reader', params: { id: project.id } })).json
        .data,
    ).toHaveLength(1);
    const one = await call(renderRoute.GET, { token: 'reader', params: { id: render.id } });
    expect(one.json.render).toMatchObject({ id: render.id, qualityCheckState: 'PASSED' });
    expect(one.json.render).not.toHaveProperty('project');
    const preview = await call(previewRoute.GET, { token: 'reader', params: { id: render.id } });
    expect(preview.json).toMatchObject({
      url: `https://signed.example/renders/orgs/${org}/r.mp4`,
      expiresInSec: 3600,
    });
    expect(
      (await call(downloadRoute.GET, { token: 'reader', params: { id: render.id } })).status,
    ).toBe(403);
    const download = await call(downloadRoute.GET, { token: 'owner', params: { id: render.id } });
    expect(download.json).toMatchObject({ expiresInSec: 900 });
    expect(api.audits.at(-1)).toMatchObject({ action: 'studio.render.download' });
    expect(
      (await call(previewRoute.GET, { token: 'stranger', params: { id: render.id } })).status,
    ).toBe(404);
  });

  it('force-approves a force-approvable failure and returns the project to review', async () => {
    const { project, render } = await finishedProject(loudnessFailed);
    expect(
      (
        await call(forceApproveRoute.POST, {
          method: 'POST',
          token: 'reader',
          params: { id: render.id },
          body: { note: 'x' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(forceApproveRoute.POST, {
          method: 'POST',
          token: 'owner',
          params: { id: render.id },
          body: {},
        })
      ).status,
    ).toBe(400);
    const res = await call(forceApproveRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: render.id },
      body: { note: 'quiet by design' },
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ projectReadyForReview: true });
    expect(
      (await db.videoRender.findUniqueOrThrow({ where: { id: render.id } })).qualityCheckState,
    ).toBe('FORCE_APPROVED');
    expect((await db.videoProject.findUniqueOrThrow({ where: { id: project.id } })).state).toBe(
      'READY_FOR_REVIEW',
    );
    expect(
      (
        await call(forceApproveRoute.POST, {
          method: 'POST',
          token: 'owner',
          params: { id: render.id },
          body: { note: 'again' },
        })
      ).status,
    ).toBe(409);
  });

  it('never lets a customer force-approve a content-safety BLOCK', async () => {
    const { render } = await finishedProject(safetyBlocked);
    const res = await call(forceApproveRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: render.id },
      body: { note: 'please' },
    });
    expect(res.status).toBe(403);
    expect(res.json.message).toContain('staff moderation');
    expect(
      (await db.videoRender.findUniqueOrThrow({ where: { id: render.id } })).qualityCheckState,
    ).toBe('FAILED');
  });
});
