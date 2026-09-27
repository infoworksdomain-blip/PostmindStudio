import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as projectScriptsRoute from '../../src/app/api/studio/projects/[id]/scripts/route';
import * as regenerateScriptRoute from '../../src/app/api/studio/scripts/[id]/regenerate/route';
import * as scriptRoute from '../../src/app/api/studio/scripts/[id]/route';
import * as shotRoute from '../../src/app/api/studio/shots/[id]/route';
import * as templatesRoute from '../../src/app/api/studio/slideshow-templates/route';
import * as completeRoute from '../../src/app/api/studio/uploads/[id]/complete/route';
import * as uploadsRoute from '../../src/app/api/studio/uploads/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { seedOverlayPresets } from '../../src/lib/studio/overlays/seed-presets';
import { seedSlideshowTemplates } from '../../src/lib/studio/slideshow/seed-templates';
import type { UploadDeps } from '../../src/lib/studio/uploads/signer';
import { call } from '../helpers/api-harness';
import {
  approve,
  BUSINESS_ID,
  briefBody,
  cleanupGolden,
  createProject,
  drain,
  generate,
  getProject,
  ORG_PREFIX,
  rendersOf,
  startJourney,
  type Journey,
} from './journey-kit';

// Phase 13 track A1 journeys: upload your own video (13.5, with captions from its speech and
// multi-format output), script edit → voice-only regeneration (13.1) with word timing stored
// for karaoke (13.6), script regenerate from Layer 2 reusing the brief (13.1), shot swap and
// delete then re-render (13.2), and a listicle slideshow whose template overlay defaults become
// slide overlays (13.4).

const hasDb = Boolean(process.env.DATABASE_URL);
const HOOK_TIMEOUT_MS = 120_000;

type Edit = { timeline: { tracks: Array<{ clips: Array<Record<string, unknown>> }> } };
type Script = {
  id: string;
  targetPlatform: string;
  fullText: string;
  shots: Array<{
    id: string;
    visualTreatment: string;
    voiceoverText: string | null;
    assetId: string | null;
    voiceAssetId: string | null;
  }>;
};

describe.skipIf(!hasDb)('create and review journeys (Phase 13 A1)', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const since = new Date();

  beforeAll(async () => {
    await seedOverlayPresets(db);
    await seedSlideshowTemplates(db);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    setApiDeps(undefined);
    await db.videoUpload.deleteMany({ where: { organisationId: { startsWith: ORG_PREFIX } } });
    await cleanupGolden(db, since);
    await db.$disconnect();
  }, HOOK_TIMEOUT_MS);

  const lastEdit = (j: Journey) =>
    (j.h.adapters.shotstack.requests.at(-1) as unknown as { edit: Edit }).edit;
  const scriptsOf = async (id: string) =>
    (await call(projectScriptsRoute.GET, { token: 'reader', params: { id } })).json
      .data as Script[];

  it('CR-01 upload a video → captions from its speech → two formats → approve', async () => {
    const j = startJourney(db, 'cr01', { probe: { durationSec: 12 } });
    j.h.adapters.assemblyai.respond = () => ({
      state: 'succeeded',
      output: {
        metadata: {
          text: 'Welcome to the shop. We bake at five.',
          words: [
            { text: 'Welcome', startSec: 0.2, endSec: 0.6 },
            { text: 'to', startSec: 0.6, endSec: 0.7 },
            { text: 'the', startSec: 0.7, endSec: 0.8 },
            { text: 'shop.', startSec: 0.8, endSec: 1.2 },
            { text: 'We', startSec: 2, endSec: 2.2 },
            { text: 'bake', startSec: 2.2, endSec: 2.5 },
            { text: 'at', startSec: 2.5, endSec: 2.6 },
            { text: 'five.', startSec: 2.6, endSec: 3 },
          ],
          costPence: 1,
        },
      },
    });
    const uploads: UploadDeps = {
      signer: { presignPut: vi.fn(async ({ key }) => `https://s3.test/${key}?sig`) },
      media: j.h.media,
      storage: j.api.storage,
      bucket: 'assets',
    };
    j.api.deps.uploads = uploads;

    const created = await call(uploadsRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: {
        kind: 'source_video',
        contentType: 'video/mp4',
        sizeBytes: 2_000,
        fileName: 'shop-tour.mp4',
        businessId: BUSINESS_ID,
      },
    });
    expect(created.status).toBe(201);
    const uploadId = (created.json.upload as { id: string }).id;
    const row = await db.videoUpload.findUniqueOrThrow({ where: { id: uploadId } });
    // The browser's PUT to the presigned URL:
    await j.api.storage.put({
      bucket: 'assets',
      key: row.s3Key,
      body: new Uint8Array(2_000),
      contentType: 'video/mp4',
    });
    const done = await call(completeRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: uploadId },
    });
    expect(done.status).toBe(200);

    const id = await createProject(j, {
      name: 'Shop tour',
      businessId: BUSINESS_ID,
      sourceType: 'UPLOAD',
      uploadId,
      targetFormats: [
        { platform: 'tiktok', aspectRatio: '9:16', durationSec: 15 },
        { platform: 'youtube_short', aspectRatio: '9:16', durationSec: 15 },
      ],
    });
    const project = await generate(j, id);
    expect(project.state).toBe('READY_FOR_REVIEW');
    // Layers 1–4 were skipped: no ideation/script call, no clip, no voice.
    const systems = j.h.adapters.anthropic.requests.map((r) => (r as { system: string }).system);
    expect(systems.some((s) => s.includes('ideation layer'))).toBe(false);
    expect(systems.some((s) => s.includes('script and storyboard'))).toBe(false);
    expect(j.h.adapters.runway.requests).toHaveLength(0);
    expect(j.h.adapters.elevenlabs.requests).toHaveLength(0);
    expect(j.h.adapters.assemblyai.requests).toHaveLength(1);

    const scripts = await scriptsOf(id);
    expect(scripts).toHaveLength(2);
    for (const script of scripts) {
      expect(script.shots).toEqual([
        expect.objectContaining({ visualTreatment: 'USER_UPLOAD', voiceAssetId: null }),
      ]);
    }
    const overlays = await db.textOverlay.findMany({
      where: { shotId: scripts[0]!.shots[0]!.id },
      orderBy: { startAtSec: 'asc' },
    });
    expect(overlays.map((o) => o.text)).toEqual(['Welcome to the shop.', 'We bake at five.']);

    const renders = await rendersOf(j, id);
    expect(renders.map((r) => r.targetPlatform).sort()).toEqual(['tiktok', 'youtube_short']);
    const edit = lastEdit(j);
    const clips = edit.timeline.tracks.flatMap((t) => t.clips);
    const video = clips.find((c) => (c.asset as { type: string }).type === 'video');
    expect((video?.asset as { volume: number }).volume).toBe(1); // the upload's own audio
    expect(JSON.stringify(edit)).toContain('Welcome to the shop.');
    await approve(j, id);
  });

  it('CR-02 edit the script: narration re-voices one shot; word timing is stored', async () => {
    const j = startJourney(db, 'cr02');
    const id = await createProject(j, briefBody());
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
    const [script] = await scriptsOf(id);
    const shot = script!.shots[0]!;
    const voice = await db.videoAsset.findUniqueOrThrow({ where: { id: shot.voiceAssetId! } });
    expect((voice.metadata as { wordTiming: { status: string } }).wordTiming.status).toBe('ok');
    const renderCalls = j.h.adapters.shotstack.requests.length;
    const voiceCalls = j.h.adapters.elevenlabs.requests.length;

    const res = await call(scriptRoute.PATCH, {
      method: 'PATCH',
      token: 'owner',
      params: { id: script!.id },
      body: {
        fullText: 'Still buying bread from a shelf? Our sourdough is baked at dawn.',
        shots: [{ id: shot.id, voiceoverText: 'Still buying bread from a shelf?' }],
      },
    });
    expect(res.status).toBe(200);
    expect(res.json.staleRenders).toHaveLength(1);
    await drain(j);
    const after = await getProject(j, id);
    expect(after.state).toBe('READY_FOR_REVIEW');
    expect(j.h.adapters.elevenlabs.requests.length).toBe(voiceCalls + 1); // one shot re-voiced
    expect(j.h.adapters.runway.requests.length).toBe(2); // visuals kept
    expect(j.h.adapters.shotstack.requests.length).toBe(renderCalls + 1);
    const project = await db.videoProject.findUniqueOrThrow({ where: { id } });
    expect((project.metadata as { staleRenders: string[] }).staleRenders).toEqual([]);
  });

  it('CR-03 regenerate the script from Layer 2 with an instruction, reusing the brief', async () => {
    const j = startJourney(db, 'cr03');
    const id = await createProject(j, briefBody());
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
    const [script] = await scriptsOf(id);
    const ideationCalls = () =>
      j.h.adapters.anthropic.requests.filter((r) =>
        (r as { system: string }).system.includes('ideation layer'),
      ).length;
    expect(ideationCalls()).toBe(1);

    const res = await call(regenerateScriptRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: script!.id },
      body: { instruction: 'Punchier hook, mention the Saturday class' },
    });
    expect(res.status).toBe(202);
    await drain(j);
    expect((await getProject(j, id)).state).toBe('READY_FOR_REVIEW');
    expect(ideationCalls()).toBe(1); // Layer 1 not re-run
    const scriptPrompts = j.h.adapters.anthropic.requests.filter((r) =>
      (r as { system: string }).system.includes('script and storyboard'),
    );
    expect(scriptPrompts).toHaveLength(2);
    expect((scriptPrompts.at(-1) as { prompt: string }).prompt).toContain('Saturday class');
    const [rewritten] = await scriptsOf(id);
    expect(rewritten!.id).toBe(script!.id);
    expect(rewritten!.shots.map((s) => s.id)).not.toContain(script!.shots[0]!.id);
    await approve(j, id);
  });

  it('CR-04 swap a shot for a library image and delete a shot, then re-render', async () => {
    const j = startJourney(db, 'cr04');
    const id = await createProject(j, briefBody());
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
    const [script] = await scriptsOf(id);
    const image = await db.imageLibraryItem.create({
      data: {
        organisationId: j.org,
        businessId: BUSINESS_ID,
        source: 'UPLOAD',
        s3Bucket: 'assets',
        s3Key: `orgs/${j.org}/loaf.png`,
        widthPx: 1080,
        heightPx: 1920,
        fileSizeBytes: 100,
        tags: ['loaf'],
        fingerprint: `cr04-${Date.now()}`,
      },
    });
    const swap = await call(shotRoute.PATCH, {
      method: 'PATCH',
      token: 'owner',
      params: { id: script!.shots[1]!.id },
      body: { imageLibraryId: image.id },
    });
    expect(swap.status).toBe(200);
    const del = await call(shotRoute.DELETE, {
      method: 'DELETE',
      token: 'owner',
      params: { id: script!.shots[2]!.id },
    });
    expect(del.status).toBe(200);
    expect((del.json.script as { shots: unknown[] }).shots).toHaveLength(2);

    // The re-render is 12 s now (15 s minus the deleted 3 s end card).
    const probed = await j.h.media.probe('x');
    vi.mocked(j.h.media.probe).mockResolvedValue({ ...probed, durationSec: 12 });
    const [render] = await rendersOf(j, id);
    const { POST: rerender } = await import('../../src/app/api/studio/renders/[id]/rerender/route');
    expect(
      (await call(rerender, { method: 'POST', token: 'owner', params: { id: render!.id } })).status,
    ).toBe(202);
    await drain(j);
    expect((await getProject(j, id)).state).toBe('READY_FOR_REVIEW');
    const edit = JSON.stringify(lastEdit(j));
    expect(edit).toContain('loaf.png');
    expect(edit).not.toContain('Subscribe today.');
  });

  it('CR-05 a listicle template turns its overlay defaults into slide overlays', async () => {
    const j = startJourney(db, 'cr05');
    const templates = (await call(templatesRoute.GET, { token: 'reader' })).json.data as Array<{
      id: string;
      category: string;
    }>;
    const listicle = templates.find((t) => t.category === 'listicle_5');
    const id = await createProject(j, {
      name: 'Five reasons',
      businessId: BUSINESS_ID,
      sourceType: 'SLIDESHOW',
      targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 15 }],
      slideshow: { templateId: listicle?.id, topic: 'Why our sourdough is different' },
    });
    const { POST: autoPopulate } =
      await import('../../src/app/api/studio/projects/[id]/auto-populate/route');
    await call(autoPopulate, { method: 'POST', token: 'owner', params: { id } });
    await drain(j);
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
    const overlays = await db.textOverlay.findMany({ where: { slide: { projectId: id } } });
    expect(overlays).toHaveLength(5);
    expect(overlays.map((o) => o.text)).toContain('1. Slow 48-hour ferment');
    // A second generation keeps (does not duplicate) them.
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
    expect(await db.textOverlay.count({ where: { slide: { projectId: id } } })).toBe(5);
  });
});
