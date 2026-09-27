import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as regenerateRoute from '../../src/app/api/studio/scripts/[id]/regenerate/route';
import * as scriptRoute from '../../src/app/api/studio/scripts/[id]/route';
import * as shotRoute from '../../src/app/api/studio/shots/[id]/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { call, installApi, tenant } from '../helpers/api-harness';

// Phase 13.1 (PATCH /scripts/:id, POST /scripts/:id/regenerate) and 13.2 (PATCH /shots/:id
// asset swap, DELETE /shots/:id): auth, validation, tenant isolation, audit, stale renders.

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('script edit and shot swap/delete API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-a1-${randomUUID()}`;
  const tokens = {
    owner: tenant(org),
    reader: tenant(org, ['studio:project:read']),
    stranger: tenant(`api-a1-other-${randomUUID()}`),
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
    await db.textOverlay.deleteMany({ where: { shot: { script: { projectId: { in: ids } } } } });
    await db.videoShot.deleteMany({ where: { script: { projectId: { in: ids } } } });
    await db.videoScript.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoBrief.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoRender.deleteMany({ where: { projectId: { in: ids } } });
    await db.videoAsset.deleteMany({ where: { organisationId: org } });
    await db.imageLibraryItem.deleteMany({ where: { organisationId: org } });
    await db.videoProject.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  async function finished(
    options: { state?: 'READY_FOR_REVIEW' | 'RENDERING'; brief?: boolean; business?: string } = {},
  ) {
    const runId = randomUUID();
    const project = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId: options.business ?? 'biz',
        createdByUserId: 'user-1',
        name: 'Done',
        state: options.state ?? 'READY_FOR_REVIEW',
        sourceType: 'BRIEF',
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 10 }],
        metadata: { runId },
      },
    });
    if (options.brief !== false)
      await db.videoBrief.create({
        data: {
          projectId: project.id,
          rawInput: 'Sourdough',
          hook: 'Hook',
          keyMessage: 'Fresh',
          targetAudience: 'Leeds',
          tone: 'warm',
          keywords: ['bread'],
          ideationModel: 'anthropic:test',
        },
      });
    const script = await db.videoScript.create({
      data: {
        projectId: project.id,
        targetPlatform: 'tiktok',
        targetAspectRatio: '9:16',
        targetDurationSec: 10,
        fullText: 'Hello there. Subscribe.',
        scriptModel: 'anthropic:test',
        shots: {
          create: [
            {
              sortOrder: 0,
              durationSec: 6,
              visualTreatment: 'AI_CLIP',
              sceneDescription: 'bread',
              voiceoverText: 'Hello there.',
              state: 'READY',
              assetId: 'asset-1',
              voiceAssetId: 'voice-1',
            },
            {
              sortOrder: 1,
              durationSec: 4,
              visualTreatment: 'TEXT_CARD',
              sceneDescription: 'card',
              voiceoverText: 'Subscribe.',
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
        qualityCheckState: 'PASSED',
      },
    });
    await db.videoProject.update({
      where: { id: project.id },
      data: { metadata: { runId, renders: { [script.id]: render.id } } },
    });
    return { project, script, shots: script.shots, render };
  }

  const patchScript = (token: string, id: string, body: unknown) =>
    call(scriptRoute.PATCH, { method: 'PATCH', token, params: { id }, body });

  it('PATCH /scripts/:id: text-only edits start no run and mark renders stale', async () => {
    const { project, script, shots, render } = await finished();
    const res = await patchScript('owner', script.id, {
      fullText: 'Hello friends. Subscribe.',
      shots: [{ id: shots[1]!.id, onScreenText: 'Join us' }],
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      runId: null,
      voiceRegenerated: [],
      staleRenders: [render.id],
    });
    expect(res.json.script).toMatchObject({ fullText: 'Hello friends. Subscribe.', version: 2 });
    const after = await db.videoProject.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.state).toBe('READY_FOR_REVIEW');
    expect((after.metadata as { staleRenders: string[] }).staleRenders).toEqual([render.id]);
    expect(api.queue.history).toHaveLength(0);
    expect(api.audits.at(-1)).toMatchObject({
      action: 'studio.script.update',
      resource: { type: 'video_script', id: script.id },
    });
  });

  it('PATCH /scripts/:id: changed narration re-voices only those shots in a new run', async () => {
    const { project, script, shots } = await finished();
    const res = await patchScript('owner', script.id, {
      shots: [
        { id: shots[0]!.id, voiceoverText: 'Good morning.' },
        { id: shots[1]!.id, voiceoverText: 'Subscribe.' }, // unchanged
      ],
    });
    expect(res.status).toBe(200);
    expect(res.json.voiceRegenerated).toEqual([shots[0]!.id]);
    const shot = await db.videoShot.findUniqueOrThrow({ where: { id: shots[0]!.id } });
    expect(shot).toMatchObject({ voiceAssetId: null, assetId: 'asset-1', state: 'QUEUED' });
    const untouched = await db.videoShot.findUniqueOrThrow({ where: { id: shots[1]!.id } });
    expect(untouched.state).toBe('READY');
    const after = await db.videoProject.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.state).toBe('ASSETS_QUEUED');
    expect(api.queue.history).toEqual([
      expect.objectContaining({
        name: 'generate-asset',
        data: expect.objectContaining({ shotId: shots[0]!.id, runId: res.json.runId }),
      }),
    ]);
    // Generating now: edits conflict.
    expect((await patchScript('owner', script.id, { fullText: 'x' })).status).toBe(409);
  });

  it('PATCH /scripts/:id validates, checks access and scopes to the organisation', async () => {
    const { script } = await finished();
    expect((await patchScript('owner', script.id, {})).status).toBe(400);
    expect((await patchScript('owner', script.id, { shots: [{ id: 'nope' }] })).status).toBe(400);
    expect((await patchScript('owner', script.id, { fullText: 'x', extra: 1 })).status).toBe(400);
    expect((await patchScript('reader', script.id, { fullText: 'x' })).status).toBe(403);
    expect((await patchScript('stranger', script.id, { fullText: 'x' })).status).toBe(404);
    const busy = await finished({ state: 'RENDERING' });
    expect((await patchScript('owner', busy.script.id, { fullText: 'x' })).status).toBe(409);
  });

  it('POST /scripts/:id/regenerate starts a Layer 2 run reusing the brief', async () => {
    const { project, script, render } = await finished();
    const res = await call(regenerateRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: script.id },
      body: { instruction: 'Punchier hook, mention the Saturday class' },
    });
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ project: { id: project.id, state: 'QUEUED' } });
    const after = await db.videoProject.findUniqueOrThrow({ where: { id: project.id } });
    const metadata = after.metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({
      runId: res.json.runId,
      renders: {},
      staleRenders: [render.id],
      scriptRegenerate: {
        runId: res.json.runId,
        scriptId: script.id,
        instruction: 'Punchier hook, mention the Saturday class',
      },
    });
    expect(api.queue.history.at(-1)).toMatchObject({ name: 'plan-project' });
    expect(api.audits.at(-1)).toMatchObject({ action: 'studio.script.regenerate' });
  });

  it('POST /scripts/:id/regenerate refuses without a brief, when busy, or across orgs', async () => {
    const noBrief = await finished({ brief: false });
    const post = (token: string, id: string, body: unknown = {}) =>
      call(regenerateRoute.POST, { method: 'POST', token, params: { id }, body });
    expect((await post('owner', noBrief.script.id)).status).toBe(409);
    const busy = await finished({ state: 'RENDERING' });
    expect((await post('owner', busy.script.id)).status).toBe(409);
    const ok = await finished();
    expect((await post('stranger', ok.script.id)).status).toBe(404);
    expect((await post('reader', ok.script.id)).status).toBe(403);
    expect((await post('owner', ok.script.id, { instruction: '' })).status).toBe(400);
  });

  it('PATCH /shots/:id swaps in a library image and marks renders stale', async () => {
    const { project, shots, render } = await finished();
    const image = await db.imageLibraryItem.create({
      data: {
        organisationId: org,
        businessId: 'biz',
        source: 'UPLOAD',
        s3Bucket: 'assets',
        s3Key: `orgs/${org}/img.png`,
        widthPx: 1080,
        heightPx: 1920,
        fileSizeBytes: 1000,
        tags: [],
        fingerprint: `fp-${randomUUID()}`,
      },
    });
    const res = await call(shotRoute.PATCH, {
      method: 'PATCH',
      token: 'owner',
      params: { id: shots[1]!.id },
      body: { imageLibraryId: image.id },
    });
    expect(res.status).toBe(200);
    expect(res.json.staleRenders).toEqual([render.id]);
    const shot = res.json.shot as { assetId: string; visualTreatment: string; state: string };
    expect(shot).toMatchObject({ visualTreatment: 'IMAGE_STILL', state: 'READY' });
    const asset = await db.videoAsset.findUniqueOrThrow({ where: { id: shot.assetId } });
    expect(asset).toMatchObject({ kind: 'IMAGE', projectId: project.id, s3Key: image.s3Key });
    expect(api.audits.at(-1)).toMatchObject({ action: 'studio.shot.swap_asset' });

    // An asset of another business is refused; so is a hotlink-only stock image.
    const other = await finished({ business: 'other-biz' });
    const foreign = await db.videoAsset.create({
      data: {
        organisationId: org,
        projectId: other.project.id,
        kind: 'VIDEO_CLIP',
        source: 'runway',
        s3Bucket: 'assets',
        s3Key: 'k.mp4',
      },
    });
    const swap = (body: unknown, token = 'owner') =>
      call(shotRoute.PATCH, { method: 'PATCH', token, params: { id: shots[0]!.id }, body });
    expect((await swap({ assetId: foreign.id })).status).toBe(400);
    const hotlink = await db.imageLibraryItem.create({
      data: {
        organisationId: org,
        businessId: 'biz',
        source: 'STOCK',
        s3Bucket: '',
        s3Key: '',
        publicUrl: 'https://stock.test/1.jpg',
        widthPx: 10,
        heightPx: 10,
        fileSizeBytes: 0,
        tags: [],
        fingerprint: `stock-${randomUUID()}`,
      },
    });
    expect((await swap({ imageLibraryId: hotlink.id })).status).toBe(400);
    expect((await swap({ assetId: 'a', imageLibraryId: 'b' })).status).toBe(400);
    expect((await swap({ imageLibraryId: image.id }, 'reader')).status).toBe(403);
    expect((await swap({ imageLibraryId: image.id }, 'stranger')).status).toBe(404);
  });

  it('PATCH /shots/:id swaps in a clip of the same business', async () => {
    const { project, shots } = await finished();
    const clip = await db.videoAsset.create({
      data: {
        organisationId: org,
        projectId: project.id,
        kind: 'VIDEO_CLIP',
        source: 'upload',
        s3Bucket: 'assets',
        s3Key: 'clip.mp4',
      },
    });
    const res = await call(shotRoute.PATCH, {
      method: 'PATCH',
      token: 'owner',
      params: { id: shots[0]!.id },
      body: { assetId: clip.id },
    });
    expect(res.status).toBe(200);
    expect(res.json.shot).toMatchObject({ assetId: clip.id, visualTreatment: 'USER_UPLOAD' });
  });

  it('DELETE /shots/:id re-times the script and refuses the last shot', async () => {
    const { script, shots, render } = await finished();
    const del = (id: string, token = 'owner') =>
      call(shotRoute.DELETE, { method: 'DELETE', token, params: { id } });
    expect((await del(shots[0]!.id, 'reader')).status).toBe(403);
    expect((await del(shots[0]!.id, 'stranger')).status).toBe(404);
    const res = await del(shots[0]!.id);
    expect(res.status).toBe(200);
    expect(res.json.staleRenders).toEqual([render.id]);
    expect(res.json.script).toMatchObject({
      id: script.id,
      targetDurationSec: 4,
      fullText: 'Subscribe.',
      shots: [expect.objectContaining({ id: shots[1]!.id, sortOrder: 0 })],
    });
    expect(api.audits.at(-1)).toMatchObject({ action: 'studio.shot.delete' });
    expect((await del(shots[1]!.id)).status).toBe(409);
  });
});
