import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as generateRoute from '../../src/app/api/studio/projects/[id]/generate/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import type { StockImageSource } from '../../src/lib/studio/images/stock';
import { seedOverlayPresets } from '../../src/lib/studio/overlays/seed-presets';
import { clipBudgetOf } from '../../src/lib/studio/pipeline/clip-budget';
import type { QualityCheck } from '../../src/lib/studio/pipeline/quality-checks';
import { createProviderRegistry } from '../../src/lib/studio/providers/registry';
import { call } from '../helpers/api-harness';
import { SCRIPT_JSON } from '../helpers/pipeline-harness';
import { ScriptedAdapter } from '../helpers/scripted-adapter';
import {
  briefBody,
  cleanupGolden,
  createProject,
  drain,
  generate,
  getProject,
  startJourney,
} from './journey-kit';
import { goldenWebsite } from './website-fixture';

// BACKLOG 20.25 — cheaper videos (operator decision 2026-10-03). The model writes the QA run 3
// worst case — every shot an AI clip — and the clip budget still holds: a STANDARD 30 s short
// generates at most four AI clips (each requested at ≤ 4 s, 720p); the other shots become the
// business's / stock images with a Ken Burns move, or a motion-graphics card when no image is
// found; no image is generated; and the video passes the quality gate to READY_FOR_REVIEW.
// A BASIC short asks the provider for 480p.

const hasDb = Boolean(process.env.DATABASE_URL);
const HOOK_TIMEOUT_MS = 120_000;

type Clip = { asset: Record<string, unknown>; start: number; length: number } & Record<
  string,
  unknown
>;
type Edit = { timeline: { tracks: Array<{ clips: Clip[] }> } };

const NARRATION = 'Fresh sourdough, baked at dawn.';
const WORDS = [
  ['Fresh', 0.1, 0.4],
  ['sourdough,', 0.4, 0.9],
  ['baked', 1.0, 1.3],
  ['at', 1.3, 1.4],
  ['dawn.', 1.4, 1.8],
].map(([text, startSec, endSec]) => ({
  text: text as string,
  startSec: startSec as number,
  endSec: endSec as number,
}));

/** Every shot an AI clip; the model marks the hook, the demo (shot 4) and the call to action. */
function allAiScript(shots: number, sec: number) {
  return {
    fullText: Array.from({ length: shots }, () => NARRATION).join(' '),
    shots: Array.from({ length: shots }, (_, i) => ({
      ...SCRIPT_JSON.shots[0],
      durationSec: sec,
      visualTreatment: 'AI_CLIP',
      // Only the next-to-last shot describes something the stock library has (and once a stock
      // image is in the business's library, later searches may find it there).
      sceneDescription: i === shots - 2 ? `stockable bakery scene ${i}` : `bespoke scene ${i}`,
      voiceoverText: NARRATION,
      onScreenText: `Headline ${i}`,
      transitionOut: 'cut',
      beat: i === 0 ? 'hook' : i === 4 ? 'demo' : i === shots - 1 ? 'cta' : 'other',
    })),
  };
}

/** The GP-09 stock source, answering only "stockable" scenes. */
function selectiveStock(): { stock: StockImageSource; pageFetch: typeof fetch } {
  const { stock, pageFetch } = goldenWebsite();
  return {
    pageFetch,
    stock: {
      ...stock,
      search: async (input) => (input.query.includes('stockable') ? stock.search(input) : []),
    },
  };
}

describe.skipIf(!hasDb)('golden: AI clip budget (20.25)', { timeout: 180_000 }, () => {
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

  it('CB-01 STANDARD 30 s short: ≤ 4 AI clips, images or cards for the rest → READY_FOR_REVIEW', async () => {
    const { stock, pageFetch } = selectiveStock();
    const j = startJourney(db, 'cb01', {
      script: allAiScript(10, 3),
      transcriptWords: WORDS,
      probe: { durationSec: 30 },
      stockSources: [stock],
      pageFetch,
    });
    const id = await createProject(
      j,
      briefBody({ targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 30 }] }),
    );
    const done = await generate(j, id);
    expect(done.state, done.errorReason ?? '').toBe('READY_FOR_REVIEW');

    // Layer 3 asked for four AI clips (STANDARD: one per ~7 s of a 30 s short), ≤ 4 s at 720p.
    const clips = j.h.adapters.runway.requests.filter((r) => r.capability === 'text_to_video');
    expect(clips.length).toBeLessThanOrEqual(5);
    expect(clips).toHaveLength(4);
    for (const r of clips) {
      expect(r).toMatchObject({ resolution: '720p' });
      expect((r as { durationSec: number }).durationSec).toBeLessThanOrEqual(4);
    }
    // No image was generated: converted shots use library / stock images or a card.
    expect(j.h.adapters.openai.requests.filter((r) => r.capability === 'text_to_image')).toEqual(
      [],
    );

    const shots = await db.videoShot.findMany({
      where: { script: { projectId: id } },
      orderBy: { sortOrder: 'asc' },
    });
    const assets = new Map(
      (
        await db.videoAsset.findMany({
          where: { id: { in: shots.flatMap((s) => (s.assetId ? [s.assetId] : [])) } },
        })
      ).map((a) => [a.id, a]),
    );
    expect(shots).toHaveLength(10);
    const ai = shots.filter((s) => s.visualTreatment === 'AI_CLIP').map((s) => s.sortOrder);
    expect(ai).toHaveLength(4);
    // The hook, the demo and the call to action keep their AI clips.
    expect(ai).toEqual(expect.arrayContaining([0, 4, 9]));
    const converted = shots.filter((s) => clipBudgetOf(s.providerRouting));
    expect(converted).toHaveLength(6);
    for (const shot of converted) {
      expect(shot.state).toBe('READY');
      if (shot.visualTreatment === 'IMAGE_STILL') {
        const asset = shot.assetId ? assets.get(shot.assetId) : undefined;
        expect(asset?.kind).toBe('IMAGE');
        expect(asset?.source).toMatch(/^image-library:/);
      } else {
        expect(shot.visualTreatment).toBe('MOTION_GRAPHICS');
        expect(shot.assetId).toBeNull();
      }
    }
    // The stockable scene found an image; the others (no library or stock match) became cards.
    expect(converted.find((s) => s.sortOrder === 8)?.visualTreatment).toBe('IMAGE_STILL');
    expect(converted.filter((s) => s.visualTreatment === 'MOTION_GRAPHICS')).toHaveLength(5);

    // The edit: stills fill the frame (cover) with alternating Ken Burns moves.
    const edit = (j.h.adapters.shotstack.requests.at(-1) as unknown as { edit: Edit }).edit;
    const stills = edit.timeline.tracks
      .flatMap((t) => t.clips)
      .filter((c) => c.asset.type === 'image' && c.length > 1);
    expect(stills.length).toBeGreaterThan(0);
    for (const still of stills) {
      expect(still.fit).toBe('cover');
      expect(['zoomIn', 'zoomOut']).toContain(still.effect);
    }
    if (stills.length > 1) expect(new Set(stills.map((s) => s.effect)).size).toBe(2);

    const render = await db.videoRender.findFirst({ where: { projectId: id } });
    expect(render?.qualityCheckState).toBe('PASSED');
    const checks = (render?.qualityIssues ?? []) as unknown as QualityCheck[];
    expect(checks.find((c) => c.code === 'black_frames')?.status).toBe('passed');
  });

  it('CB-03 an IMAGE_STILL the model chose uses a stock image before any generation', async () => {
    const { stock, pageFetch } = selectiveStock();
    const base = SCRIPT_JSON.shots[0];
    const j = startJourney(db, 'cb03', {
      script: {
        fullText: NARRATION,
        shots: [
          { ...base, durationSec: 4, visualTreatment: 'AI_CLIP', voiceoverText: NARRATION },
          {
            ...base,
            durationSec: 4,
            visualTreatment: 'IMAGE_STILL',
            sceneDescription: 'stockable sourdough loaf on a board',
            voiceoverText: NARRATION,
          },
          { ...base, durationSec: 4, visualTreatment: 'AI_CLIP', voiceoverText: NARRATION },
          { ...base, durationSec: 3, visualTreatment: 'TEXT_CARD', voiceoverText: NARRATION },
        ],
      },
      transcriptWords: WORDS,
      stockSources: [stock],
      pageFetch,
    });
    const id = await createProject(j);
    const done = await generate(j, id);
    expect(done.state, done.errorReason ?? '').toBe('READY_FOR_REVIEW');
    expect(j.h.adapters.openai.requests.filter((r) => r.capability === 'text_to_image')).toEqual(
      [],
    );
    const still = await db.videoShot.findFirst({
      where: { script: { projectId: id }, visualTreatment: 'IMAGE_STILL' },
    });
    expect(clipBudgetOf(still?.providerRouting)).toBeNull();
    expect((still?.providerRouting as { visual?: { chosenBy?: string } }).visual?.chosenBy).toBe(
      'stock',
    );
  });

  it('CB-02 BASIC 15 s short: two AI clips, requested at 480p', async () => {
    const j = startJourney(db, 'cb02', {
      script: allAiScript(5, 3),
      transcriptWords: WORDS,
      probe: { durationSec: 15 },
    });
    // BASIC routes AI clips seedance → kling → veo (20.25); the harness has only Runway.
    const seedance = new ScriptedAdapter(
      'seedance',
      ['text_to_video', 'image_to_video'],
      () => ({
        state: 'succeeded',
        output: { url: 'https://seedance.invalid/clip.mp4', metadata: { costPence: 11 } },
      }),
      11,
    );
    j.h.deps.registry = createProviderRegistry([...j.h.deps.registry.list(), seedance]);
    const id = await createProject(j);
    const res = await call(generateRoute.POST, {
      method: 'POST',
      token: 'owner',
      params: { id },
      body: { qualityTier: 'BASIC' },
    });
    expect(res.status).toBe(202);
    await drain(j);
    const done = await getProject(j, id);
    expect(done.state, done.errorReason ?? '').toBe('READY_FOR_REVIEW');
    expect(seedance.requests).toHaveLength(2);
    for (const r of seedance.requests) expect(r).toMatchObject({ resolution: '480p' });
    expect(j.h.adapters.runway.requests).toEqual([]);
  });
});
