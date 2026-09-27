import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../errors';
import { buildSlideshowEdit } from '../slideshow/edl';
import {
  buildShotstackEdit,
  MUSIC_ALONE_VOLUME,
  MUSIC_UNDER_VOICE_VOLUME,
  musicClips,
} from './edl';
import {
  DEFAULT_MUSIC_MIN_TIER,
  musicAllowedForTier,
  musicRequestSec,
  parseMusicMinTier,
} from './music';

type Track = { clips: Array<{ asset: Record<string, unknown>; start: number; length: number }> };
const tracksOf = (edit: Record<string, unknown>) => (edit.timeline as { tracks: Track[] }).tracks;

describe('music tier gating (spec 12.4)', () => {
  it('defaults to STANDARD and above; BASIC stays narration-only', () => {
    expect(DEFAULT_MUSIC_MIN_TIER).toBe('STANDARD');
    expect(parseMusicMinTier(undefined)).toBe('STANDARD');
    expect(parseMusicMinTier(' plus ')).toBe('PLUS');
    expect(() => parseMusicMinTier('gold')).toThrow(ConfigurationError);
    expect(musicAllowedForTier('BASIC', 'STANDARD')).toBe(false);
    expect(musicAllowedForTier('STANDARD', 'STANDARD')).toBe(true);
    expect(musicAllowedForTier('ENTERPRISE', 'PLUS')).toBe(true);
    expect(musicAllowedForTier('STANDARD', 'PLUS')).toBe(false);
  });

  it('requests the video length within the documented 3 s – 5 min', () => {
    expect(musicRequestSec(0.5)).toBe(3);
    expect(musicRequestSec(14.2)).toBe(15);
    expect(musicRequestSec(360)).toBe(300);
  });
});

describe('music in the Shotstack edit', () => {
  const shots = [
    {
      durationSec: 6,
      visualTreatment: 'AI_CLIP' as const,
      visualSrc: 'https://v/1.mp4',
      voiceSrc: 'https://a/1.mp3',
    },
    { durationSec: 4, visualTreatment: 'TEXT_CARD' as const, cardText: 'Subscribe' },
  ];

  it('lays the track under narration at a ducked volume and fades it out', () => {
    const edit = buildShotstackEdit({
      aspectRatio: '9:16',
      shots,
      musicSrc: 'https://m/track.mp3',
      musicDurationSec: 30,
    });
    const music = tracksOf(edit).at(-1);
    expect(music?.clips).toEqual([
      {
        asset: {
          type: 'audio',
          src: 'https://m/track.mp3',
          volume: MUSIC_UNDER_VOICE_VOLUME,
          effect: 'fadeOut',
        },
        start: 0,
        length: 10,
      },
    ]);
    expect(MUSIC_UNDER_VOICE_VOLUME).toBeLessThan(MUSIC_ALONE_VOLUME);
  });

  it('raises the bed when there is no narration', () => {
    const edit = buildShotstackEdit({
      aspectRatio: '9:16',
      shots: [{ ...shots[0]!, voiceSrc: undefined }],
      musicSrc: 'https://m/track.mp3',
    });
    expect(tracksOf(edit).at(-1)?.clips[0]?.asset.volume).toBe(MUSIC_ALONE_VOLUME);
  });

  it('has no music track without a track', () => {
    const edit = buildShotstackEdit({ aspectRatio: '9:16', shots });
    expect(
      tracksOf(edit).some((t) => t.clips.some((c) => c.asset.src === 'https://m/track.mp3')),
    ).toBe(false);
  });

  it('loops a track shorter than the video, fading only the last clip', () => {
    const clips = musicClips({ src: 's', trackSec: 300, videoSec: 720, volume: 0.2 });
    expect(clips.map((c) => [c.start, c.length])).toEqual([
      [0, 300],
      [300, 300],
      [600, 120],
    ]);
    expect(clips.map((c) => (c.asset as { effect?: string }).effect)).toEqual([
      undefined,
      undefined,
      'fadeOut',
    ]);
  });

  it('slideshows carry the track as the only audio', () => {
    const edit = buildSlideshowEdit({
      aspectRatio: '9:16',
      slides: [
        {
          slideType: 'TEXT_CARD',
          durationSec: 3,
          transitionIn: null,
          backgroundColor: null,
          content: { text: 'hi' },
        },
      ],
      musicSrc: 'https://m/track.mp3',
      musicDurationSec: 3,
    });
    expect(tracksOf(edit).at(-1)?.clips).toEqual([
      {
        asset: {
          type: 'audio',
          src: 'https://m/track.mp3',
          volume: MUSIC_ALONE_VOLUME,
          effect: 'fadeOut',
        },
        start: 0,
        length: 3,
      },
    ]);
  });
});
