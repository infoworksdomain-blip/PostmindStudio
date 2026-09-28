import { describe, expect, it } from 'vitest';
import {
  captionModeFor,
  captionStyle,
  narrationLines,
  timelineLines,
  toSrt,
} from './voice-captions';

describe('voice captions (15.A4)', () => {
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
