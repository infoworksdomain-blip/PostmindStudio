import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineDeps } from './deps';
import {
  overlayHoldSec,
  rebalanceNarration,
  rebalancedFit,
  retimedOverlays,
} from './narration-rebalance';

// 21.1 — applying the rebalance before composition (DB writes, probes, review-screen metadata).

const mergeProjectMetadata = vi.fn(async () => true);
vi.mock('./project-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./project-state')>()),
  mergeProjectMetadata: (...a: unknown[]) => mergeProjectMetadata(...(a as [])),
}));

const run8Words = [
  { text: 'hours', startSec: 1.974, endSec: 2.121 },
  { text: 'to', startSec: 2.235, endSec: 2.365 },
  { text: 'prep.', startSec: 2.382, endSec: 2.741 },
];
const trimFit = {
  strategy: 'trim',
  voiceSec: 2.741,
  shotSec: 2.5,
  trimSec: 2.415,
  wordBoundary: true,
  sentenceBoundary: false,
  droppedWords: 1,
  speedApplied: true,
};

interface ShotRow {
  id: string;
  sortOrder: number;
  durationSec: number;
  visualTreatment: string;
  assetId: string | null;
  voiceAssetId: string | null;
  onScreenText: string | null;
  voiceoverText: string | null;
  overlays: Array<{ id: string; startAtSec: number; endAtSec: number }>;
}

const row = (over: Partial<ShotRow> & { id: string; sortOrder: number }): ShotRow => ({
  durationSec: 3,
  visualTreatment: 'IMAGE_STILL',
  assetId: null,
  voiceAssetId: null,
  onScreenText: null,
  voiceoverText: null,
  overlays: [],
  ...over,
});

function fixture(
  over: { shots?: ShotRow[]; assets?: unknown[]; runId?: string; target?: number } = {},
) {
  const shots = over.shots ?? [
    row({ id: 'hook', sortOrder: 0, voiceAssetId: 'v_hook' }),
    row({
      id: 'still',
      sortOrder: 1,
      durationSec: 2.5,
      assetId: 'img',
      voiceAssetId: 'v_still',
    }),
    row({
      id: 'card',
      sortOrder: 2,
      visualTreatment: 'TEXT_CARD',
      onScreenText: 'Book a demo',
      overlays: [
        { id: 'ov_full', startAtSec: 0, endAtSec: 3 },
        { id: 'ov_mid', startAtSec: 0.2, endAtSec: 1.5 },
      ],
    }),
  ];
  const assets = over.assets ?? [
    {
      id: 'v_hook',
      kind: 'AUDIO_VOICE',
      metadata: { fit: { strategy: 'fits', voiceSec: 2.6, shotSec: 3 } },
    },
    { id: 'v_still', kind: 'AUDIO_VOICE', metadata: { words: run8Words, fit: trimFit } },
    { id: 'img', kind: 'IMAGE', metadata: {}, s3Bucket: 'a', s3Key: 'img.png', durationSec: null },
  ];
  const tx = {
    videoShot: { update: vi.fn(async () => ({})) },
    textOverlay: { update: vi.fn(async () => ({})) },
    videoAsset: { update: vi.fn(async () => ({})) },
  };
  const probe = vi.fn(async () => ({ durationSec: 5 }));
  const d = {
    db: {
      videoProject: {
        findFirst: vi.fn(async () => ({
          sourceType: 'PROMPT',
          metadata: { runId: over.runId ?? 'run_1' },
          scripts: [
            { id: 'scr_1', targetPlatform: 'tiktok', targetDurationSec: over.target ?? 7, shots },
          ],
        })),
      },
      videoAsset: { findMany: vi.fn(async () => assets) },
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    },
    media: { probe },
    storage: { signedUrl: vi.fn(async (_b: string, key: string) => `https://s/${key}`) },
    logger: pino({ level: 'silent' }),
  } as unknown as PipelineDeps;
  return { d, tx, probe };
}

const input = { projectId: 'prj_1', organisationId: 'org_1', runId: 'run_1' };

beforeEach(() => mergeProjectMetadata.mockClear());

describe('rebalanceNarration', () => {
  it('QA run 8: lengthens the still, shortens the card, and plays the narration whole', async () => {
    const { d, tx } = fixture();
    const result = await rebalanceNarration(d, input);
    expect(result).toEqual({ lengthened: 1, shortened: [] });
    expect(tx.videoShot.update).toHaveBeenCalledWith({
      where: { id: 'still' },
      data: { durationSec: 3 },
    });
    expect(tx.videoShot.update).toHaveBeenCalledWith({
      where: { id: 'card' },
      data: { durationSec: 2.5 },
    });
    // The full-length overlay follows the card's new end; the one ending mid-shot is untouched.
    expect(tx.textOverlay.update).toHaveBeenCalledTimes(1);
    expect(tx.textOverlay.update).toHaveBeenCalledWith({
      where: { id: 'ov_full' },
      data: { endAtSec: 2.5 },
    });
    // The narration is no longer trimmed: no trimSec for the composer or the captions.
    expect(tx.videoAsset.update).toHaveBeenCalledWith({
      where: { id: 'v_still' },
      data: {
        metadata: {
          words: run8Words,
          fit: {
            strategy: 'rebalance',
            voiceSec: 2.741,
            shotSec: 2.5,
            newShotSec: 3,
            donors: [{ shotId: 'card', sec: 0.5 }],
            budgetSec: 0,
            speedApplied: true,
          },
        },
      },
    });
    expect(mergeProjectMetadata).toHaveBeenCalledWith(d.db, {
      projectId: 'prj_1',
      runId: 'run_1',
      patch: { narrationShortened: [] },
    });
  });

  it('records narration it could not save for the review screen, without writing shots', async () => {
    const { d, tx } = fixture({
      shots: [
        row({ id: 'hook', sortOrder: 0, voiceAssetId: 'v_hook', durationSec: 2.8 }),
        row({
          id: 'still',
          sortOrder: 1,
          durationSec: 2.5,
          assetId: 'img',
          voiceAssetId: 'v_still',
        }),
      ],
      target: 3.8, // no head-room left either
    });
    const result = await rebalanceNarration(d, input);
    const shortened = [
      {
        scriptId: 'scr_1',
        platform: 'tiktok',
        shotId: 'still',
        shotNumber: 2,
        voiceSec: 2.741,
        keptSec: 2.415,
        boundary: 'word',
        droppedWords: 1,
      },
    ];
    expect(result).toEqual({ lengthened: 0, shortened });
    expect(d.db.$transaction).not.toHaveBeenCalled();
    expect(tx.videoShot.update).not.toHaveBeenCalled();
    expect(mergeProjectMetadata).toHaveBeenCalledWith(d.db, {
      projectId: 'prj_1',
      runId: 'run_1',
      patch: { narrationShortened: shortened },
    });
  });

  it('lets an AI clip play longer only as far as its probed source runs', async () => {
    const shots = [
      row({
        id: 'clip',
        sortOrder: 0,
        durationSec: 2.5,
        visualTreatment: 'AI_CLIP',
        assetId: 'mp4',
        voiceAssetId: 'v_still',
      }),
      row({ id: 'card', sortOrder: 1, visualTreatment: 'TEXT_CARD' }),
    ];
    const assets = [
      { id: 'v_still', kind: 'AUDIO_VOICE', metadata: { fit: trimFit } },
      {
        id: 'mp4',
        kind: 'VIDEO_CLIP',
        metadata: {},
        s3Bucket: 'a',
        s3Key: 'c.mp4',
        durationSec: 2.5,
      },
    ];
    const long = fixture({ shots, assets });
    expect((await rebalanceNarration(long.d, input)).lengthened).toBe(1);
    expect(long.probe).toHaveBeenCalledWith('https://s/c.mp4');

    const short = fixture({ shots, assets });
    short.probe.mockResolvedValueOnce({ durationSec: 2.6 });
    expect((await rebalanceNarration(short.d, input)).shortened).toHaveLength(1);

    // A failed probe falls back to the recorded (requested) length: 2.5 s cannot hold 3 s.
    const unknown = fixture({ shots, assets });
    unknown.probe.mockRejectedValueOnce(new Error('ffprobe missing'));
    expect((await rebalanceNarration(unknown.d, input)).lengthened).toBe(0);
  });

  it('leaves a shot alone when its stored fit has no usable measurement', async () => {
    const { d, tx } = fixture({
      assets: [
        {
          id: 'v_hook',
          kind: 'AUDIO_VOICE',
          metadata: { fit: { strategy: 'fits', voiceSec: 2.6 } },
        },
        { id: 'v_still', kind: 'AUDIO_VOICE', metadata: { fit: { strategy: 'trim', trimSec: 2 } } },
      ],
    });
    const result = await rebalanceNarration(d, input);
    expect(result.lengthened).toBe(0);
    expect(result.shortened).toMatchObject([{ shotId: 'still', voiceSec: null, keptSec: 2 }]);
    expect(tx.videoShot.update).not.toHaveBeenCalled();
  });

  it('does nothing for a stale run or a slideshow', async () => {
    const stale = fixture({ runId: 'run_old' });
    expect(await rebalanceNarration(stale.d, input)).toEqual({ lengthened: 0, shortened: [] });
    expect(mergeProjectMetadata).not.toHaveBeenCalled();
    const slideshow = fixture();
    vi.mocked(slideshow.d.db.videoProject.findFirst).mockResolvedValueOnce({
      sourceType: 'SLIDESHOW',
      metadata: { runId: 'run_1' },
    } as never);
    expect(await rebalanceNarration(slideshow.d, input)).toEqual({ lengthened: 0, shortened: [] });
  });
});

describe('overlay timing', () => {
  const overlays = [
    { id: 'full', startAtSec: 0.5, endAtSec: 3 },
    { id: 'mid', startAtSec: 0, endAtSec: 2.2 },
  ];

  it('keeps overlays that end inside the shot whole, and 1.2 s of one that runs to the end', () => {
    expect(overlayHoldSec(overlays, 3)).toBe(2.2);
    expect(overlayHoldSec([{ id: 'late', startAtSec: 1.5, endAtSec: 3 }], 3)).toBe(2.7);
    expect(overlayHoldSec([{ id: 'very-late', startAtSec: 2.5, endAtSec: 3 }], 3)).toBe(3);
    expect(overlayHoldSec([], 3)).toBe(0);
  });

  it('moves the end of overlays that ran to the old shot end', () => {
    expect(retimedOverlays(overlays, 3, 2.5)).toEqual([{ id: 'full', endAtSec: 2.5 }]);
    expect(retimedOverlays(overlays, 3, 3.4)).toEqual([{ id: 'full', endAtSec: 3.4 }]);
  });

  it('records a rebalanced fit without the trim', () => {
    expect(
      rebalancedFit(
        { strategy: 'trim', voiceSec: 3, shotSec: 2.5, trimSec: 2, wordBoundary: true },
        { shotId: 's', fromSec: 2.5, toSec: 3.2, donors: [], budgetSec: 0.7 },
      ),
    ).toEqual({
      strategy: 'rebalance',
      voiceSec: 3,
      shotSec: 2.5,
      newShotSec: 3.2,
      donors: [],
      budgetSec: 0.7,
    });
  });
});
