import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as presetRoute from '../../src/app/api/studio/overlay-presets/[id]/route';
import * as presetsRoute from '../../src/app/api/studio/overlay-presets/route';
import * as previewRoute from '../../src/app/api/studio/overlays/[id]/preview/route';
import * as overlayRoute from '../../src/app/api/studio/overlays/[id]/route';
import * as bulkRoute from '../../src/app/api/studio/renders/[id]/overlays/bulk/route';
import * as rerenderRoute from '../../src/app/api/studio/renders/[id]/rerender/route';
import * as shotOverlaysRoute from '../../src/app/api/studio/shots/[id]/overlays/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { seedOverlayPresets } from '../../src/lib/studio/overlays/seed-presets';
import type { ProjectJobData } from '../../src/lib/studio/queue/queues';
import { drainInline } from '../../src/lib/studio/queue/workers/runtime';
import { call, installApi, tenant } from '../helpers/api-harness';
import { createHarness, createProject } from '../helpers/pipeline-harness';

// BACKLOG 8.1–8.7 end to end: a generated project gets auto-suggested overlays (8.5); the user
// adds a styled hook overlay, previews it, applies a whole-video watermark and re-renders; the
// Shotstack edit carries rich-text overlay clips and the fonts they need.

const hasDb = Boolean(process.env.DATABASE_URL);

type Edit = {
  timeline: {
    fonts?: Array<{ src: string }>;
    tracks: Array<{
      clips: Array<{ asset: Record<string, unknown>; start: number; length: number }>;
    }>;
  };
  output: Record<string, unknown>;
};

describe.skipIf(!hasDb)('overlay API + re-render', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-overlays-${randomUUID()}`;
  const tokens = {
    owner: tenant(org),
    reader: tenant(org, ['studio:project:read']),
    other: tenant(`api-overlays-other-${randomUUID()}`),
  };
  let h: ReturnType<typeof createHarness>;
  let projectId: string;

  beforeAll(async () => {
    await seedOverlayPresets(db);
    h = createHarness(db);
    installApi(db, tokens, { queue: h.queue, publishing: h.deps.publishing, pipeline: h.deps });
    const { project, runId } = await createProject(db, { organisationId: org });
    projectId = project.id;
    const job: ProjectJobData = { projectId, organisationId: org, runId, planTier: 'STANDARD' };
    await h.queue.add('plan-project', job);
    await drainInline(h.queue, h.deps);
  });

  afterAll(async () => {
    setApiDeps(undefined);
    const shots = await db.videoShot.findMany({
      where: { script: { projectId } },
      select: { id: true },
    });
    const renders = await db.videoRender.findMany({ where: { projectId }, select: { id: true } });
    await db.textOverlay.deleteMany({
      where: {
        OR: [
          { shotId: { in: shots.map((s) => s.id) } },
          { renderId: { in: renders.map((r) => r.id) } },
        ],
      },
    });
    await db.overlayPreset.deleteMany({ where: { organisationId: org } });
    await db.videoShot.deleteMany({ where: { script: { projectId } } });
    await db.videoScript.deleteMany({ where: { projectId } });
    await db.videoBrief.deleteMany({ where: { projectId } });
    await db.videoRender.deleteMany({ where: { projectId } });
    await db.videoAsset.deleteMany({ where: { projectId } });
    await db.providerJob.deleteMany({ where: { organisationId: org } });
    await db.providerUsage.deleteMany({ where: { organisationId: org } });
    await db.videoProject.deleteMany({ where: { id: projectId } });
    await db.$disconnect();
  });

  const shots = () =>
    db.videoShot.findMany({
      where: { script: { projectId } },
      orderBy: { sortOrder: 'asc' },
      include: { overlays: true },
    });
  const lastEdit = () => (h.adapters.shotstack.requests.at(-1) as unknown as { edit: Edit }).edit;
  /** 15.A4 narration captions are their own lane (ids in project.metadata.voiceCaptions). */
  const captionIds = async () => {
    const { metadata } = await db.videoProject.findUniqueOrThrow({ where: { id: projectId } });
    const records = (
      (metadata ?? {}) as { voiceCaptions?: Record<string, { overlayIds: string[] }> }
    ).voiceCaptions;
    return new Set(Object.values(records ?? {}).flatMap((r) => r.overlayIds));
  };

  it('proposes styled overlays at script time and composes them as rich-text', async () => {
    const project = await db.videoProject.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.state).toBe('READY_FOR_REVIEW');
    const [hook, , card] = await shots();
    const captions = await captionIds();
    const suggested = hook?.overlays.filter((o) => !captions.has(o.id)) ?? [];
    expect(suggested).toHaveLength(1);
    // The caption lane never repeats the hook text the auto-suggested overlay already shows.
    const hookCaptions = hook?.overlays.filter((o) => captions.has(o.id)) ?? [];
    expect(hookCaptions.every((o) => o.sortOrder >= 50)).toBe(true);
    expect(hookCaptions.map((o) => o.text)).not.toContain('Still buying supermarket bread?');
    expect(hook?.overlays.filter((o) => !captions.has(o.id))[0]).toMatchObject({
      text: 'Still buying supermarket bread?',
      fontFamily: 'Montserrat',
      animationIn: 'popIn',
    });
    expect(suggested[0]?.presetId).toBeTruthy(); // seeded built-in "TikTok Native"
    // TEXT_CARD shots show their own text: no suggested overlay (captions are another lane).
    expect(card?.overlays.filter((o) => !captions.has(o.id))).toHaveLength(0);
    expect(card?.overlays.map((o) => o.text)).not.toContain('Subscribe today');

    const edit = lastEdit();
    const top = edit.timeline.tracks[0]?.clips[0];
    expect(top?.asset).toMatchObject({
      type: 'rich-text',
      text: 'Still buying supermarket bread?',
    });
    expect(edit.timeline.fonts).toEqual([{ src: 'https://fonts.test/Montserrat.ttf' }]);
    // the plain html caption for that shot is gone
    expect(JSON.stringify(edit)).not.toContain('<p>Still buying supermarket bread?</p>');
  });

  it('manages presets: built-ins are read-only, org presets are private', async () => {
    const hooks = await call(presetsRoute.GET, {
      token: 'reader',
      path: '/api/studio/overlay-presets?group=hook',
    });
    const builtIns = hooks.json.data as Array<{ id: string; name: string; scope: string }>;
    expect(builtIns.map((p) => p.name)).toEqual(
      expect.arrayContaining([
        'Bold Centre',
        'Bold Left',
        'Retro Yellow',
        'Ransom Note',
        'TikTok Native',
      ]),
    );
    const all = await call(presetsRoute.GET, { token: 'reader' });
    expect((all.json.data as unknown[]).length).toBeGreaterThanOrEqual(25);

    const created = await call(presetsRoute.POST, {
      method: 'POST',
      token: 'owner',
      body: {
        name: 'Our hook',
        group: 'hook',
        scope: 'org',
        parameters: { fontFamily: 'Anton', fillColor: '#FFCC00', fontSizePct: 8 },
      },
    });
    expect(created.status).toBe(201);
    const presetId = (created.json.preset as { id: string }).id;
    expect(
      (
        await call(presetsRoute.POST, {
          method: 'POST',
          token: 'owner',
          body: { name: 'x', group: 'hook', scope: 'org', parameters: { fontFamily: "Arial'; x" } },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(presetRoute.PATCH, {
          method: 'PATCH',
          token: 'owner',
          params: { id: builtIns[0]?.id ?? '' },
          body: { name: 'mine now' },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(presetRoute.PATCH, {
          method: 'PATCH',
          token: 'other',
          params: { id: presetId },
          body: { name: 'stolen' },
        })
      ).status,
    ).toBe(404);
    const renamed = await call(presetRoute.PATCH, {
      method: 'PATCH',
      token: 'owner',
      params: { id: presetId },
      body: { name: 'Our big hook' },
    });
    expect((renamed.json.preset as { name: string }).name).toBe('Our big hook');
    const otherList = await call(presetsRoute.GET, { token: 'other' });
    expect(JSON.stringify(otherList.json)).not.toContain('Our big hook');
  });

  it('adds, edits, previews, watermarks and re-renders', async () => {
    const [, second] = await shots();
    const shotId = second?.id ?? '';
    const presets = await call(presetsRoute.GET, {
      token: 'reader',
      path: '/api/studio/overlay-presets?group=statistic',
    });
    const countUp = (presets.json.data as Array<{ id: string; name: string }>).find(
      (p) => p.name === 'Count-Up',
    );

    const added = await call(shotOverlaysRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: shotId },
      body: {
        text: 'Baked at 4am',
        startAtSec: 0.5,
        endAtSec: 3,
        presetId: undefined,
        style: { animationIn: 'slideInLeft', fillColor: '#FFD400', anchorY: 0.2 },
      },
    });
    expect(added.status).toBe(201);
    const overlayId = (added.json.overlay as { id: string }).id;
    expect(
      (
        await call(shotOverlaysRoute.POST, {
          method: 'POST',
          token: 'owner',
          params: { id: shotId },
          body: { text: 'Too long', startAtSec: 0, endAtSec: 60 },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(shotOverlaysRoute.POST, {
          method: 'POST',
          token: 'other',
          params: { id: shotId },
          body: { text: 'x', startAtSec: 0, endAtSec: 1 },
        })
      ).status,
    ).toBe(404);
    // Count-Up needs an FFmpeg pre-render; keep it out of the composed video in this test.
    expect(countUp).toBeTruthy();

    const edited = await call(overlayRoute.PATCH, {
      method: 'PATCH',
      token: 'owner',
      params: { id: overlayId },
      body: { text: 'Baked fresh at 4am', style: { fontSizePct: 6 } },
    });
    expect(edited.status).toBe(200);
    expect(edited.json.overlay).toMatchObject({
      text: 'Baked fresh at 4am',
      fontSizePct: 6,
      fillColor: '#FFD400',
      animationIn: 'slideInLeft',
    });

    const listed = await call(shotOverlaysRoute.GET, { token: 'reader', params: { id: shotId } });
    const captions = await captionIds();
    const listedIds = (listed.json.data as Array<{ id: string }>).map((o) => o.id);
    // Narration captions are listed too (user-editable, spec 3.1) but are their own lane.
    expect(listedIds.filter((id) => !captions.has(id))).toEqual([overlayId]);

    expect(
      (
        await call(previewRoute.POST, {
          method: 'POST',
          token: 'reader',
          params: { id: overlayId },
        })
      ).status,
    ).toBe(403);
    const preview = await call(previewRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: overlayId },
    });
    expect(preview.status).toBe(200);
    expect((preview.json.preview as { url: string }).url).toContain('signed.example');
    const previewEdit = lastEdit();
    expect(previewEdit.output).toMatchObject({
      resolution: 'preview',
      range: { start: 0, length: 3 },
    });
    expect(previewEdit.timeline.tracks[0]?.clips[0]?.asset).toMatchObject({
      type: 'rich-text',
      text: 'Baked fresh at 4am',
    });

    const render = await db.videoRender.findFirstOrThrow({ where: { projectId } });
    const watermark = await call(bulkRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: render.id },
      body: {
        overlay: {
          text: '@leedssourdough',
          startAtSec: 0,
          endAtSec: render.durationSec,
          style: { anchorX: 0.85, anchorY: 0.05, fontSizePct: 2 },
        },
      },
    });
    expect(watermark.status).toBe(201);

    const before = h.adapters.shotstack.requests.length;
    const clipsBefore = h.adapters.runway.requests.length;
    const rerender = await call(rerenderRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id: render.id },
    });
    expect(rerender.status).toBe(202);
    await drainInline(h.queue, h.deps);
    expect(h.adapters.shotstack.requests.length).toBe(before + 1);
    expect(h.adapters.runway.requests.length).toBe(clipsBefore); // no new AI clips for a re-render
    const project = await db.videoProject.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.state).toBe('READY_FOR_REVIEW');
    expect(await db.videoRender.count({ where: { projectId } })).toBe(2);

    const edit = JSON.stringify(lastEdit());
    expect(edit).toContain('Baked fresh at 4am');
    expect(edit).toContain('@leedssourdough');
    expect(edit).toContain('"type":"rich-text"');

    // Locked while not reviewable; deletable again once reviewed.
    const removed = await call(overlayRoute.DELETE, {
      method: 'DELETE',
      token: 'owner',
      params: { id: overlayId },
    });
    expect(removed.status).toBe(200);
    expect(
      (
        await call(overlayRoute.DELETE, {
          method: 'DELETE',
          token: 'owner',
          params: { id: overlayId },
        })
      ).status,
    ).toBe(404);
  });
});
