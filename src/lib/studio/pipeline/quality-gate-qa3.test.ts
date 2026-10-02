import { describe, expect, it } from 'vitest';
import type { SpokenWord } from '../overlays/word-timing';
import { CAPTION_KIND, mirrorsNarration, ON_SCREEN_KIND } from '../overlays/kind';
import { spokenCaptions } from './quality-brand-gate';
import type { MediaProbe } from './media-probe';
import { BLACK_FRAME_MAX_SEC, evaluateQuality, qualityPassed } from './quality-checks';
import { evaluateCaptionSync } from './quality-sync';

// BACKLOG 20.22 — the two failures of QA run 3 (project cmuqw30wy0000rp07uvgvuiud):
//   tiktok/black_frames: black 7.2–8.0s, 25.8–26.3s, 27.7–30.0s
//   tiktok/caption_sync: "Meeting panic mode": words not found in the narration; …

const words = (...spec: Array<[string, number, number]>): SpokenWord[] =>
  spec.map(([text, startSec, endSec]) => ({ text, startSec, endSec }));

/** The narration of one shot: "When the meeting panic hits, AheadAI drafts your opener." */
const NARRATION = words(
  ['When', 0.1, 0.3],
  ['the', 0.3, 0.4],
  ['meeting', 0.4, 0.8],
  ['panic', 0.8, 1.1],
  ['hits,', 1.1, 1.4],
  ['AheadAI', 1.5, 2.0],
  ['drafts', 2.0, 2.3],
  ['your', 2.3, 2.45],
  ['opener.', 2.45, 2.9],
);

const overlay = (
  id: string,
  text: string,
  startAtSec: number,
  endAtSec: number,
  extra: { kind?: string; animationIn?: string } = {},
) => ({
  id,
  text,
  startAtSec,
  endAtSec,
  kind: extra.kind ?? ON_SCREEN_KIND,
  animationIn: extra.animationIn ?? 'fadeIn',
});

describe('20.22 caption_sync only judges overlays that mirror the narration', () => {
  it('ignores headline, title, CTA and text-card overlays, however many words are spoken', () => {
    // Before 20.22 these (on the subtitle_box preset, ≥ 50 % of words spoken) were checked and
    // failed with "words not found in the narration".
    const captions = spokenCaptions([
      {
        overlays: [
          overlay('h1', 'Meeting panic mode', 0, 3),
          overlay('h2', 'AheadAI to the rescue', 0, 3),
          overlay('h3', 'Your opener, drafted', 0, 3),
          overlay('cta', 'Try AheadAI free', 0, 3, { animationIn: 'scaleIn' }),
        ],
        words: NARRATION,
      },
    ]);
    expect(captions).toEqual([]);
    expect(evaluateCaptionSync(captions)).toMatchObject({
      code: 'caption_sync',
      status: 'not_run',
      detailKey: 'noSpokenCaptions',
    });
  });

  it('still checks narration captions: in sync passes, out of sync or wrong words fail', () => {
    const shot = (o: ReturnType<typeof overlay>[]) =>
      spokenCaptions([{ overlays: o, words: NARRATION }]);
    const inSync = shot([
      overlay('c1', 'When the meeting panic hits,', 0.1, 1.5, { kind: CAPTION_KIND }),
      overlay('c2', 'AheadAI drafts your opener.', 1.5, 3.0, { kind: CAPTION_KIND }),
      overlay('h1', 'Meeting panic mode', 0, 3),
    ]);
    expect(inSync.map((c) => c.overlayId)).toEqual(['c1', 'c2']);
    expect(evaluateCaptionSync(inSync)).toMatchObject({
      status: 'passed',
      detailKey: 'captionSyncPassed',
    });

    const late = shot([
      overlay('c1', 'When the meeting panic hits,', 0.6, 1.5, { kind: CAPTION_KIND }),
    ]);
    expect(evaluateCaptionSync(late)).toMatchObject({ status: 'failed', severity: 'error' });

    const wrong = shot([
      overlay('c1', 'Totally different words', 0.1, 1.5, { kind: CAPTION_KIND }),
    ]);
    expect(evaluateCaptionSync(wrong).detail).toContain('words not found in the narration');
  });

  it('a narration caption on a shot with no word timing fails closed', () => {
    const captions = spokenCaptions([
      { overlays: [overlay('c1', 'When the meeting', 0, 1, { kind: CAPTION_KIND })], words: [] },
    ]);
    expect(evaluateCaptionSync(captions)).toMatchObject({ status: 'failed' });
  });

  it('karaoke overlays follow the narration whatever their kind', () => {
    expect(mirrorsNarration({ kind: ON_SCREEN_KIND, animationIn: 'karaokeHighlight' })).toBe(true);
    expect(mirrorsNarration({ kind: CAPTION_KIND, animationIn: 'fadeIn' })).toBe(true);
    expect(mirrorsNarration({ kind: ON_SCREEN_KIND, animationIn: 'popIn' })).toBe(false);
    expect(mirrorsNarration({ kind: 'something-else', animationIn: 'fadeIn' })).toBe(false);
  });
});

describe('20.22 black_frames threshold (spec 13.1: black > 500 ms fails)', () => {
  const probe: MediaProbe = {
    durationSec: 30,
    width: 1080,
    height: 1920,
    fps: 30,
    videoCodec: 'h264',
    videoProfile: 'High',
    audioCodec: 'aac',
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    bitRateKbps: 4500,
  };
  const blackCheck = (intervals: Array<[number, number]>) =>
    evaluateQuality({
      target: { durationSec: 30, aspectRatio: '9:16' },
      probe,
      blackIntervals: intervals.map(([startSec, endSec]) => ({
        startSec,
        endSec,
        durationSec: Math.round((endSec - startSec) * 1e6) / 1e6,
      })),
      loudnessLufs: -14,
      contentSafety: { skipped: 'no_provider' },
      sync: [],
    }).find((c) => c.code === 'black_frames');

  it('passes an intentional short dip (≤ 0.3 s) and one of exactly 0.5 s', () => {
    expect(blackCheck([[10, 10.3]])).toMatchObject({ status: 'passed' });
    expect(blackCheck([[10, 10 + BLACK_FRAME_MAX_SEC]])?.status).toBe('passed');
    expect(blackCheck([])).toMatchObject({ status: 'passed', detailKey: 'noBlackFrames' });
  });

  it('fails the QA run 3 gaps and names each of them', () => {
    const check = blackCheck([
      [7.2, 8.0],
      [25.7667, 26.3],
      [27.7, 30.0],
    ]);
    expect(check).toMatchObject({ status: 'failed', severity: 'error', detailKey: 'blackFrames' });
    expect(check?.detail).toBe('black 7.2–8.0s, 25.8–26.3s, 27.7–30.0s');
  });

  it('a soft failure (black frames) never blocks: severity error, force-approvable', () => {
    const checks = evaluateQuality({
      target: { durationSec: 30, aspectRatio: '9:16' },
      probe,
      blackIntervals: [{ startSec: 27.7, endSec: 30, durationSec: 2.3 }],
      loudnessLufs: -14,
      contentSafety: { skipped: 'no_provider' },
      sync: [],
    });
    expect(qualityPassed(checks)).toBe(false);
    expect(checks.filter((c) => c.status === 'failed').every((c) => c.severity === 'error')).toBe(
      true,
    );
  });
});
