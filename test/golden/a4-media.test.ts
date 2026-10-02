import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { setApiDeps } from '../../src/lib/studio/api/context';
import type { RenderMastering } from '../../src/lib/studio/pipeline/mastering';
import { createProviderRegistry } from '../../src/lib/studio/providers/registry';
import { StoryblocksAudioAdapter } from '../../src/lib/studio/providers/storyblocks-audio';
import {
  briefBody,
  cleanupGolden,
  createProject,
  generate,
  getProject,
  rendersOf,
  startJourney,
  type Journey,
} from './journey-kit';

// Phase 13 track A4 journeys, through the real routes and workers:
//   A4-01  4-minute YouTube video: Layer 2 SFX cues → Storyblocks clips under the narration →
//          quiet render mastered to −14 LUFS → content safety "Not scanned" (20.21: Hive removed,
//          no provider, no async callback) → READY_FOR_REVIEW (long-form reaches review)

const hasDb = Boolean(process.env.DATABASE_URL);
const LONG_SEC = 240;

type Clip = { asset: { type: string; src?: string; volume?: number }; start: number };
type Edit = { timeline: { tracks: Array<{ clips: Clip[] }> } };

/** 24 × 10 s shots: an AI clip opener and text cards, three of them with SFX cues. */
const LONG_SCRIPT = {
  fullText: 'Four minutes on sourdough.',
  shots: Array.from({ length: 24 }, (_, i) => ({
    durationSec: 10,
    visualTreatment: i === 0 ? 'AI_CLIP' : 'TEXT_CARD',
    sceneDescription: `Scene ${i}`,
    cameraDirection: '',
    voiceoverText: `Line ${i}.`,
    onScreenText: `Card ${i}`,
    transitionOut: 'cut',
    ...(i === 0 || i === 5 ? { sfxCue: 'Whoosh' } : i === 10 ? { sfxCue: 'cash register' } : {}),
  })),
};

function wireA4(j: Journey) {
  const sfxFetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/api/v2/audio/search')) {
      const keywords = new URL(url).searchParams.get('keywords');
      return Response.json({
        total_results: 1,
        results: [
          {
            id: keywords === 'whoosh' ? 111 : 222,
            title: `SFX ${keywords}`,
            type: 'sfx',
            durationMs: 1500,
          },
        ],
      });
    }
    if (url.includes('/api/v2/audio/stock-item/download/')) {
      return Response.json({ MP3: 'https://cdn.storyblocks.example/sfx.mp3' });
    }
    return new Response(new Uint8Array([7, 7, 7]), { status: 200 });
  });
  const sfx = new StoryblocksAudioAdapter({
    publicKey: 'pub',
    privateKey: 'priv',
    storage: j.h.deps.storage,
    bucket: 'assets',
    fetchImpl: sfxFetch as unknown as typeof fetch,
  });
  j.h.deps.registry = createProviderRegistry([...j.h.deps.registry.list(), sfx]);
  // The composed render is quiet; the mastered copy measures −14 LUFS.
  vi.mocked(j.h.media.integratedLoudness).mockImplementation(async (url: string) =>
    url.includes('/providers/mastered/') ? -14 : -25,
  );
  const mastering: RenderMastering = {
    measure: vi.fn(async () => ({
      inputI: -25,
      inputTp: -6,
      inputLra: 5,
      inputThresh: -35,
      targetOffset: 0,
    })),
    master: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
  };
  j.h.deps.mastering = mastering;
  return { sfxFetch, mastering };
}

const longJourney = (db: PrismaClient, id: string) =>
  startJourney(db, id, {
    script: LONG_SCRIPT,
    probe: { durationSec: LONG_SEC, width: 1920, height: 1080 },
  });

const longBrief = () =>
  briefBody({
    targetFormats: [{ platform: 'youtube', aspectRatio: '16:9', durationSec: LONG_SEC }],
  });

describe.skipIf(!hasDb)('A4 media journeys', { timeout: 180_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const since = new Date();

  afterAll(async () => {
    setApiDeps(undefined);
    await cleanupGolden(db, since);
    await db.$disconnect();
  }, 120_000);

  it('A4-01 long-form: SFX, mastering, not scanned → ready for review', async () => {
    const j = longJourney(db, 'a401');
    const { sfxFetch, mastering } = wireA4(j);
    const id = await createProject(j, longBrief());

    // 20.21: no content-safety provider, so nothing waits for a scan or a callback.
    expect((await generate(j, id)).state).toBe('READY_FOR_REVIEW');
    expect(await db.contentSafetyTask.count({ where: { projectId: id } })).toBe(0);
    expect(await db.safetyReview.count({ where: { projectId: id } })).toBe(0);

    // SFX: two distinct cues fetched once each, laid at the start of their shots.
    expect(sfxFetch.mock.calls.filter(([u]) => String(u).includes('/audio/search'))).toHaveLength(
      2,
    );
    const edit = (j.h.adapters.shotstack.requests.at(-1) as unknown as { edit: Edit }).edit;
    const sfxTrack = edit.timeline.tracks.find((t) => t.clips.every((c) => c.asset.volume === 0.5));
    expect(sfxTrack?.clips.map((c) => c.start)).toEqual([0, 50, 100]);
    const pending = (await getProject(j, id)) as Awaited<ReturnType<typeof getProject>> & {
      metadata: Record<string, unknown>;
    };
    expect(pending.metadata).toMatchObject({
      sfx: {
        status: 'added',
        cues: [
          expect.objectContaining({ cue: 'Whoosh', status: 'added', title: 'SFX whoosh' }),
          expect.objectContaining({ cue: 'cash register', status: 'added' }),
        ],
      },
    });
    expect(await db.videoAsset.count({ where: { projectId: id, kind: 'AUDIO_SFX' } })).toBe(2);

    // Mastering replaced the quiet render with a normalised copy.
    expect(mastering.master).toHaveBeenCalledTimes(1);
    const [render] = await rendersOf(j, id);
    const row = await db.videoRender.findUniqueOrThrow({ where: { id: render?.id ?? '' } });
    expect(row.s3Key).toContain('/providers/mastered/');
    expect(
      Object.values(
        (pending.metadata as { mastering: Record<string, { applied: boolean }> }).mastering,
      )[0],
    ).toMatchObject({
      applied: true,
      loudnessBeforeLufs: -25,
    });

    const checked = await db.videoRender.findUniqueOrThrow({ where: { id: render?.id ?? '' } });
    expect(checked.qualityCheckState).toBe('PASSED');
    expect(checked.qualityIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'content_safety', status: 'not_run' }),
        expect.objectContaining({ code: 'audio_present', status: 'passed' }),
      ]),
    );
  });
});
