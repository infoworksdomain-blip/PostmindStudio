import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { seedOverlayPresets } from '../../src/lib/studio/overlays/seed-presets';
import { isTooDark } from '../../src/lib/studio/pipeline/edl-backdrop';
import { parseCompositionSummary } from '../../src/lib/studio/pipeline/composition-summary';
import type { QualityCheck } from '../../src/lib/studio/pipeline/quality-checks';
import { createProviderRegistry } from '../../src/lib/studio/providers/registry';
import { SCRIPT_JSON } from '../helpers/pipeline-harness';
import { ScriptedAdapter } from '../helpers/scripted-adapter';
import { briefBody, cleanupGolden, createProject, generate, startJourney } from './journey-kit';

// BACKLOG 20.22 — QA run 3 (2026-10-02): the first production video through every stage
// (project cmuqw30wy0000rp07uvgvuiud, TikTok 9:16, 30 s) ended QUALITY_FAILED on
//   black_frames (the MOTION_GRAPHICS and TEXT_CARD shots had no clip and were drawn on black)
//   caption_sync ("Meeting panic mode": headline overlays were held to the narration).
// The same shot list, with scripted providers and a media inspector that reports no black, now
// reaches READY_FOR_REVIEW: the cards and the timeline sit on a non-black backdrop, the headlines
// are not caption-checked, and the narration captions still are (and pass).

const hasDb = Boolean(process.env.DATABASE_URL);
const HOOK_TIMEOUT_MS = 120_000;

type Clip = { asset: Record<string, unknown>; start: number; length: number } & Record<
  string,
  unknown
>;
type Edit = { timeline: { background: string; tracks: Array<{ clips: Clip[] }> } };

const NARRATION = 'When the meeting panic hits, AheadAI drafts your opener.';
/** Word timings of each shot's narration (within the shortest, 2.5 s shot). */
const WORDS = [
  ['When', 0.1, 0.3],
  ['the', 0.3, 0.4],
  ['meeting', 0.4, 0.8],
  ['panic', 0.8, 1.1],
  ['hits,', 1.1, 1.4],
  ['AheadAI', 1.5, 1.8],
  ['drafts', 1.8, 2.0],
  ['your', 2.0, 2.1],
  ['opener.', 2.1, 2.4],
].map(([text, startSec, endSec]) => ({
  text: text as string,
  startSec: startSec as number,
  endSec: endSec as number,
}));

// sortOrder | durationSec | visualTreatment | on-screen headline (the production shot list).
const SHOTS: Array<[number, string, string]> = [
  [2.5, 'AI_AVATAR', 'Meeting panic mode'],
  [2.5, 'AI_CLIP', 'AheadAI to the rescue'],
  [3, 'MOTION_GRAPHICS', 'Your opener, drafted'],
  [3, 'AI_CLIP', 'Prompt in, plan out'],
  [3, 'AI_CLIP', 'Meeting panic, solved'],
  [3, 'AI_CLIP', 'Your opener in seconds'],
  [3, 'AI_CLIP', 'No more blank pages'],
  [3, 'AI_AVATAR', 'AheadAI drafts it'],
  [3, 'AI_CLIP', 'Built for busy teams'],
  [4, 'TEXT_CARD', 'Try AheadAI free'],
];

const SCRIPT = {
  fullText: SHOTS.map(() => NARRATION).join(' '),
  shots: SHOTS.map(([durationSec, visualTreatment, onScreenText], i) => ({
    ...SCRIPT_JSON.shots[0],
    durationSec,
    visualTreatment,
    sceneDescription: `QA 3 shot ${i}`,
    voiceoverText: NARRATION,
    onScreenText,
    // Fades out of shots 1 and 8, as before the text card in production.
    transitionOut: i === 1 || i === 8 ? 'fade' : 'cut',
  })),
};

describe.skipIf(!hasDb)(
  'golden: QA run 3 shot list reaches review (20.22)',
  { timeout: 180_000 },
  () => {
    const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
    const since = new Date();

    beforeAll(async () => {
      await db.$connect();
      // The built-in presets, as in production: body-shot headlines get the subtitle_box preset and
      // TikTok narration captions the hook_tiktok_native one (what misled the old check).
      await seedOverlayPresets(db);
    }, HOOK_TIMEOUT_MS);
    afterAll(async () => {
      setApiDeps(undefined);
      await cleanupGolden(db, since);
      await db.$disconnect();
    }, HOOK_TIMEOUT_MS);

    it('QA3-01 TEXT_CARD + MOTION_GRAPHICS on a backdrop, headlines not caption-checked → READY_FOR_REVIEW', async () => {
      const j = startJourney(db, 'qa3', {
        script: SCRIPT,
        transcriptWords: WORDS,
        probe: { durationSec: 30 },
      });
      // The presenter provider is out of credits, so both AI_AVATAR shots degrade to clips (20.19).
      const heygen = new ScriptedAdapter('heygen', ['avatar_video'], () => ({
        state: 'failed',
        error: { class: 'insufficient_credits', message: 'Insufficient credit', retryable: false },
      }));
      j.h.deps.registry = createProviderRegistry([...j.h.deps.registry.list(), heygen]);
      const id = await createProject(
        j,
        briefBody({
          costBudgetPence: 10_000, // nine generated clips
          targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', durationSec: 30 }],
        }),
      );
      const done = await generate(j, id);
      const found = await db.videoRender.findFirst({ where: { projectId: id } });
      if (done.state !== 'READY_FOR_REVIEW' || !found) {
        const shots = await db.videoShot.findMany({
          where: { script: { projectId: id } },
          select: { sortOrder: true, state: true, errorReason: true },
        });
        throw new Error(
          `QA3-01 ${done.state}: ${done.errorReason} ${JSON.stringify(found?.qualityIssues)} ${JSON.stringify(shots)}`,
        );
      }
      const render = found;
      const checks = (render.qualityIssues ?? []) as unknown as QualityCheck[];
      expect(render.qualityCheckState).toBe('PASSED');
      expect(j.h.media.blackIntervals).toHaveBeenCalled();
      expect(checks.find((c) => c.code === 'black_frames')?.status).toBe('passed');

      // caption_sync judged the narration captions only, and they are in sync.
      const overlays = await db.textOverlay.findMany({
        where: { shot: { script: { projectId: id } } },
      });
      const captions = overlays.filter((o) => o.kind === 'caption');
      const headlines = overlays.filter((o) => SHOTS.some(([, , text]) => text === o.text));
      expect(captions.length).toBeGreaterThan(0);
      expect(headlines.length).toBeGreaterThan(0);
      expect(headlines.every((o) => o.kind === 'on_screen')).toBe(true);
      expect(checks.find((c) => c.code === 'caption_sync')).toMatchObject({
        status: 'passed',
        detailParams: { count: captions.length },
      });

      // The edit Shotstack received: shots 2 (5.0–8.0 s) and 9 (26–30 s) have no clip, and each
      // is covered by a full-frame, non-black fill; the timeline background is not black either.
      const edit = (j.h.adapters.shotstack.requests.at(-1) as unknown as { edit: Edit }).edit;
      expect(isTooDark(edit.timeline.background)).toBe(false);
      const fills = edit.timeline.tracks
        .flatMap((t) => t.clips)
        .filter((c) => c.asset.width === 1080 && c.asset.height === 1920)
        .map((c) => ({
          start: c.start,
          end: c.start + c.length,
          colour: String(
            c.asset.type === 'shape'
              ? (c.asset.fill as { color: string }).color
              : (c.asset.background ?? ''),
          ),
        }));
      for (const [start, end] of [
        [5, 8],
        [26, 30],
      ] as const) {
        const fill = fills.find((f) => f.start <= start + 1e-6 && f.end >= end - 1e-6);
        expect(fill, `backdrop over ${start}–${end}s`).toBeDefined();
        expect(isTooDark(fill?.colour ?? '#000000')).toBe(false);
      }
      const summary = parseCompositionSummary(render.composition);
      expect(summary?.totalSec).toBe(30);
      expect(summary?.brand.backdropColour).toBe(edit.timeline.background);
    });
  },
);
