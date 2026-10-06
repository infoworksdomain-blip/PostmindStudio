import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { UpstreamServiceError } from '../../src/lib/errors';
import { seedOverlayPresets } from '../../src/lib/studio/overlays/seed-presets';
import type { LocalRenderer } from '../../src/lib/studio/render/local/renderer';
import { readTimeline } from '../../src/lib/studio/render/local/timeline';
import {
  BUSINESS_ID,
  cleanupGolden,
  createProject,
  generate,
  startJourney,
} from '../golden/journey-kit';

// BACKLOG 23.5 — the compose step's renderer choice through the real pipeline on real Postgres:
// a slideshow and a wall of text are rendered by the local renderer (no Shotstack request,
// provider local-ffmpeg, 0p) and reach review; when the local render fails they fall back to
// Shotstack automatically and still reach review. The renderer here is a stand-in that checks
// the edit is one it can read (render/local/timeline.ts) and returns MP4 bytes; the real ffmpeg
// path is test/integration/local-render-ffmpeg.test.ts.

const hasDb = Boolean(process.env.DATABASE_URL);
const HOOK_TIMEOUT_MS = 120_000;

function localRenderer(fail = false): LocalRenderer & { edits: Array<Record<string, unknown>> } {
  const edits: Array<Record<string, unknown>> = [];
  return {
    providerId: 'local-ffmpeg',
    edits,
    available: vi.fn(async () => true),
    render: vi.fn(async (edit: Record<string, unknown>) => {
      edits.push(edit);
      readTimeline(edit); // throws NotImplementedError for an edit the renderer cannot draw
      if (fail) throw new UpstreamServiceError('ffmpeg local render failed: killed');
      return {
        bytes: new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]),
        renderMs: 9_000,
        notes: [],
        measuredLufs: -20,
      };
    }),
  };
}

const SLIDES = [
  '3 habits that save an hour',
  'Plan tomorrow tonight',
  'Batch your errands',
  'Walk at lunch',
  'Phone away after nine',
  'Follow for more',
].map((text, i) => ({
  slideType: 'TEXT_CARD',
  durationSec: 2.5,
  transitionIn: i === 0 ? null : 'fade',
  content: { role: i === 0 ? 'hook' : i === 5 ? 'cta' : 'body', text },
}));

describe.skipIf(!hasDb)('local renderer in the compose step (23.5)', { timeout: 300_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const since = new Date();

  beforeAll(async () => {
    await db.$connect();
    await seedOverlayPresets(db);
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    setApiDeps(undefined);
    await cleanupGolden(db, since);
    await db.$disconnect();
  }, HOOK_TIMEOUT_MS);

  const slideshowBody = (name: string) => ({
    name,
    businessId: BUSINESS_ID,
    sourceType: 'SLIDESHOW',
    targetFormats: [
      { platform: 'tiktok', aspectRatio: '9:16', durationSec: 15 },
      { platform: 'instagram_reel', aspectRatio: '9:16', durationSec: 15 },
    ],
    costBudgetPence: 5_000,
    slideshow: { topic: SLIDES[0]?.content.text, slides: SLIDES },
  });
  const wallBody = (name: string) => ({
    name,
    businessId: BUSINESS_ID,
    sourceType: 'WALL_OF_TEXT',
    targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 8 }],
    wallOfText: { text: 'Three habits\n- Plan\n- Batch', background: 'calm', durationSec: 8 },
  });

  async function localJobs(projectId: string) {
    return db.providerJob.findMany({ where: { projectId, provider: 'local-ffmpeg' } });
  }

  it('a slideshow renders every format locally at 0p and reaches review', async () => {
    const renderer = localRenderer();
    const j = startJourney(db, 'lr01', { localRenderer: renderer });
    const id = await createProject(j, slideshowBody('Local slideshow'));
    const project = await generate(j, id);
    expect(project.state).toBe('READY_FOR_REVIEW');
    expect(j.h.adapters.shotstack.requests).toHaveLength(0);
    expect(renderer.edits).toHaveLength(2);
    const renders = await db.videoRender.findMany({ where: { projectId: id } });
    expect(renders).toHaveLength(2);
    for (const render of renders) {
      expect(render.costPence).toBe(0);
      expect(render.composerJobId).toMatch(/^local-ffmpeg:/);
      expect(render.s3Key).toContain('/providers/local-ffmpeg/');
      expect(render.qualityCheckState).toBe('PASSED');
      expect(render.composition).toMatchObject({
        renderer: { provider: 'local-ffmpeg', renderMs: 9_000 },
      });
    }
    const jobs = await localJobs(id);
    expect(jobs.map((job) => [job.state, job.costPence, job.durationMs])).toEqual([
      ['SUCCEEDED', 0, 9_000],
      ['SUCCEEDED', 0, 9_000],
    ]);
  });

  it('a wall of text renders locally at 0p and reaches review', async () => {
    const renderer = localRenderer();
    const j = startJourney(db, 'lr02', {
      localRenderer: renderer,
      stock: true,
      probe: { durationSec: 8 },
    });
    const id = await createProject(j, wallBody('Local wall of text'));
    const project = await generate(j, id);
    expect(project.state).toBe('READY_FOR_REVIEW');
    expect(j.h.adapters.shotstack.requests).toHaveLength(0);
    const [render] = await db.videoRender.findMany({ where: { projectId: id } });
    expect(render).toMatchObject({ costPence: 0, qualityCheckState: 'PASSED' });
    expect(render?.composerJobId).toMatch(/^local-ffmpeg:/);
    // The edit it drew is the one Shotstack would have got: muted background + the block.
    const timeline = readTimeline(renderer.edits[0] ?? {});
    expect(timeline.base[0]?.source.kind).toBe('video');
    expect(timeline.layers.some((l) => l.source.kind === 'text')).toBe(true);
    expect((await localJobs(id)).map((job) => [job.state, job.costPence])).toEqual([
      ['SUCCEEDED', 0],
    ]);
  });

  it('falls back to Shotstack when the local render fails, and still reaches review', async () => {
    const renderer = localRenderer(true);
    const j = startJourney(db, 'lr03', {
      localRenderer: renderer,
      stock: true,
      probe: { durationSec: 8 },
    });
    const id = await createProject(j, wallBody('Fallback wall of text'));
    const project = await generate(j, id);
    expect(project.state).toBe('READY_FOR_REVIEW');
    expect(renderer.edits).toHaveLength(1);
    expect(j.h.adapters.shotstack.requests).toHaveLength(1);
    const [render] = await db.videoRender.findMany({ where: { projectId: id } });
    expect(render?.composerJobId).toMatch(/^render-/);
    expect(render?.costPence).toBeGreaterThan(0);
    const jobs = await localJobs(id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      state: 'FAILED',
      costPence: 0,
      errorClass: 'UpstreamServiceError',
    });
  });

  it('STUDIO_LOCAL_RENDER=off (no renderer): the slideshow goes to Shotstack as before', async () => {
    const j = startJourney(db, 'lr04');
    const id = await createProject(j, slideshowBody('Shotstack slideshow'));
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
    expect(j.h.adapters.shotstack.requests).toHaveLength(2);
    expect(await localJobs(id)).toEqual([]);
  });
});
