import { describe, expect, it } from 'vitest';
import { CAPTION_SYNC_TOLERANCE_SEC, matchCaption } from '../pipeline/quality-sync';
import { UGC_CAPTION_MAX_WORDS } from './captions';
import {
  audibleWords,
  captionModeFor,
  captionStyle,
  narrationLines,
  timelineLines,
  toSrt,
  withoutOnScreenDuplicates,
} from './voice-captions';

describe('captions for trimmed narration (production QA run 8, 2026-10-04)', () => {
  // The 2.5 s still's narration, sped up once and then trimmed at 2.415 s (after "to"): "prep."
  // is cut, yet the caption showed it and stayed up to 2.5 s, 241 ms past the last heard word.
  const words = [
    { text: 'Walk', startSec: 0.097, endSec: 0.358 },
    { text: 'into', startSec: 0.358, endSec: 0.489 },
    { text: 'every', startSec: 0.603, endSec: 0.815 },
    { text: 'call', startSec: 0.93, endSec: 1.142 },
    { text: 'like', startSec: 1.256, endSec: 1.435 },
    { text: "you've", startSec: 1.484, endSec: 1.631 },
    { text: 'had', startSec: 1.648, endSec: 1.794 },
    { text: 'hours', startSec: 1.974, endSec: 2.121 },
    { text: 'to', startSec: 2.235, endSec: 2.365 },
    { text: 'prep.', startSec: 2.382, endSec: 2.741 },
  ];

  it('drops words the trim cuts off, and keeps every word when there is no trim', () => {
    expect(audibleWords(words, 2.415).map((w) => w.text)).not.toContain('prep.');
    expect(audibleWords(words, 2.415)).toHaveLength(9);
    expect(audibleWords(words, null)).toHaveLength(10);
  });

  it('captions only what is heard, inside the caption_sync tolerance', () => {
    const heard = audibleWords(words, 2.415);
    const lines = narrationLines(heard, 2.5);
    const last = lines.at(-1)!;
    expect(last.text).toBe('hours to');
    const match = matchCaption({ ...last, overlayId: 'ov-1', words });
    expect(match).not.toBeNull();
    expect(Math.abs(last.endAtSec - match!.last.endSec)).toBeLessThanOrEqual(
      CAPTION_SYNC_TOLERANCE_SEC,
    );
    expect(Math.abs(last.startAtSec - match!.first.startSec)).toBeLessThanOrEqual(
      CAPTION_SYNC_TOLERANCE_SEC,
    );
  });
});

describe('voice captions (15.A4)', () => {
  it('does not burn in a line the hook overlay already shows at the same time', () => {
    const hook = { text: 'Still buying supermarket bread?', startAtSec: 0, endAtSec: 3 };
    const lines = [
      { text: 'Still buying', startAtSec: 0.1, endAtSec: 0.9 },
      { text: 'supermarket bread?', startAtSec: 0.9, endAtSec: 2 },
      { text: 'Bake it fresh', startAtSec: 2.1, endAtSec: 2.9 },
      // Same words, but after the hook has left the screen: kept.
      { text: 'supermarket bread', startAtSec: 3.2, endAtSec: 4 },
    ];
    expect(withoutOnScreenDuplicates(lines, [hook]).map((l) => l.text)).toEqual([
      'Bake it fresh',
      'supermarket bread',
    ]);
  });

  it('matches whole words in order, not substrings', () => {
    const shown = [{ text: 'Whatever the weather', startAtSec: 0, endAtSec: 5 }];
    const lines = [
      { text: 'Ever', startAtSec: 0, endAtSec: 1 },
      { text: 'weather the', startAtSec: 1, endAtSec: 2 },
      { text: 'WHATEVER the', startAtSec: 2, endAtSec: 3 },
    ];
    expect(withoutOnScreenDuplicates(lines, shown).map((l) => l.text)).toEqual([
      'Ever',
      'weather the',
    ]);
    expect(withoutOnScreenDuplicates(lines, [])).toEqual(lines);
  });

  it('burns in everywhere except YouTube long-form, which gets an SRT', () => {
    expect(captionModeFor('youtube')).toBe('srt');
    for (const p of [
      'tiktok',
      'instagram_reel',
      'youtube_short',
      'facebook',
      'x',
      'linkedin_video',
    ])
      expect(captionModeFor(p)).toBe('burn');
  });

  it('uses a TikTok-native look on TikTok and the subtitle box elsewhere', () => {
    const tiktok = captionStyle('tiktok', null);
    const reel = captionStyle('instagram_reel', { primary: '#112233' });
    expect(tiktok?.presetName).toBe('TikTok Native');
    expect(tiktok?.style.anchorY).toBe(0.7);
    expect(tiktok?.style.fontSizePct).toBe(4);
    expect(reel?.presetName).toBe('Box Background');
    expect(reel?.style.anchorY).toBe(0.7);
  });

  it('21.4b: a UGC video uses the box-less outlined TikTok classic look on every platform', () => {
    const brand = { primary: '#0A0A23', secondary: '#101040', fontFamily: 'Lora' };
    for (const platform of ['tiktok', 'instagram_reel', 'youtube_short', 'facebook']) {
      const chosen = captionStyle(platform, brand, { ugc: true });
      expect(chosen?.presetName).toBe('TikTok Classic');
      // Readability comes from the stroke: the brand never recolours it, the text stays white.
      expect(chosen?.style).toMatchObject({
        backgroundType: 'none',
        backgroundColor: null,
        fillColor: '#FFFFFF',
        strokeColor: '#000000',
        fontFamily: 'Montserrat',
        fontSizePct: 3.6,
        anchorY: 0.7,
      });
    }
  });

  it('21.4b: UGC captions are chunks of at most 6 words', () => {
    const said = 'so I tried this for a week and honestly my mornings feel calmer now'
      .split(' ')
      .map((text, i) => ({ text, startSec: i * 0.3, endSec: i * 0.3 + 0.25 }));
    const ugc = narrationLines(said, 8, UGC_CAPTION_MAX_WORDS);
    expect(ugc.every((l) => l.text.split(' ').length <= 6)).toBe(true);
    expect(ugc.map((l) => l.text).join(' ')).toBe(said.map((w) => w.text).join(' '));
    // Ordinary narration keeps its 7-word lines.
    expect(narrationLines(said, 8)[0]?.text.split(' ')).toHaveLength(7);
  });

  it('places each shot’s lines on the video timeline', () => {
    const lines = timelineLines([
      {
        id: 's2',
        sortOrder: 1,
        durationSec: 3,
        words: [{ text: 'Second.', startSec: 0.2, endSec: 0.8 }],
      },
      {
        id: 's1',
        sortOrder: 0,
        durationSec: 2.5,
        words: [
          { text: 'Friday', startSec: 0.4, endSec: 0.8 },
          { text: 'means', startSec: 0.8, endSec: 1.1 },
          { text: 'sourdough', startSec: 1.1, endSec: 2.1 },
        ],
      },
    ]);
    expect(lines).toEqual([
      { text: 'Friday means sourdough', startAtSec: 0.4, endAtSec: 2.1 },
      { text: 'Second.', startAtSec: 2.7, endAtSec: 3.3 },
    ]);
  });

  it('ends a narration line with its last word (caption_sync ±200 ms), not the 0.6 s minimum', () => {
    expect(narrationLines([{ text: 'Ever', startSec: 0.1, endSec: 0.4 }], 6)).toEqual([
      { text: 'Ever', startAtSec: 0.1, endAtSec: 0.5 },
    ]);
  });

  it('formats SubRip cues (numbered, comma milliseconds; RTL text passes through)', () => {
    const srt = toSrt([
      { text: 'Friday means sourdough', startAtSec: 0.4, endAtSec: 2.1 },
      { text: 'خبز طازج', startAtSec: 3661.005, endAtSec: 3662 },
    ]);
    expect(srt).toBe(
      '1\n00:00:00,400 --> 00:00:02,100\nFriday means sourdough\n\n2\n01:01:01,005 --> 01:01:02,000\nخبز طازج\n',
    );
    expect(toSrt([])).toBe('');
  });
});
