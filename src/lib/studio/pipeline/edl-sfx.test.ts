import { describe, expect, it } from 'vitest';
import { buildShotstackEdit, SFX_MAX_SEC, SFX_VOLUME, type EdlShot } from './edl';
import { normaliseScript, normaliseSfxCue, scriptSchema, SCRIPT_SYSTEM_PROMPT } from './scripting';

// BACKLOG 13.27 — the Layer 2 sfx cue and its clips in the Shotstack edit.

const shot = (over: Partial<EdlShot>): EdlShot => ({
  durationSec: 4,
  visualTreatment: 'AI_CLIP',
  visualSrc: 'https://s/clip.mp4',
  voiceSrc: 'https://s/voice.mp3',
  ...over,
});

type Track = {
  clips: Array<{
    asset: { type: string; src?: string; volume?: number };
    start: number;
    length: number;
  }>;
};

describe('buildShotstackEdit sound effects', () => {
  it('adds an SFX track under the narration and above the music, at each shot start', () => {
    const edit = buildShotstackEdit({
      aspectRatio: '9:16',
      shots: [
        shot({ sfxSrc: 'https://s/whoosh.mp3', sfxDurationSec: 1.2 }),
        shot({ durationSec: 2 }),
        shot({ durationSec: 2, sfxSrc: 'https://s/ding.mp3', sfxDurationSec: 8 }),
      ],
      musicSrc: 'https://s/music.mp3',
      musicDurationSec: 30,
    });
    const tracks = (edit.timeline as { tracks: Track[] }).tracks;
    const srcs = tracks.map((t) => t.clips[0]?.asset.src ?? t.clips[0]?.asset.type);
    expect(srcs).toEqual([
      'https://s/clip.mp4',
      'https://s/voice.mp3',
      'https://s/whoosh.mp3',
      'https://s/music.mp3',
    ]);
    const sfx = tracks[2]?.clips ?? [];
    expect(sfx).toEqual([
      {
        asset: { type: 'audio', src: 'https://s/whoosh.mp3', volume: SFX_VOLUME },
        start: 0,
        length: 1.2,
      },
      // Capped at SFX_MAX_SEC and at the shot's own length.
      {
        asset: { type: 'audio', src: 'https://s/ding.mp3', volume: SFX_VOLUME },
        start: 6,
        length: 2,
      },
    ]);
    expect(SFX_MAX_SEC).toBe(3);
  });

  it('uses SFX_MAX_SEC when the clip length is unknown and adds no track without cues', () => {
    const edit = buildShotstackEdit({
      aspectRatio: '9:16',
      shots: [shot({ durationSec: 6, sfxSrc: 'https://s/hit.mp3', sfxDurationSec: null })],
    });
    const tracks = (edit.timeline as { tracks: Track[] }).tracks;
    expect(tracks.at(-1)?.clips[0]?.length).toBe(SFX_MAX_SEC);
    const plain = buildShotstackEdit({ aspectRatio: '9:16', shots: [shot({})] });
    expect((plain.timeline as { tracks: Track[] }).tracks).toHaveLength(2);
  });
});

describe('script sfxCue', () => {
  const base = {
    durationSec: 5,
    visualTreatment: 'TEXT_CARD',
    sceneDescription: 'card',
    cameraDirection: '',
    voiceoverText: 'Hello',
    onScreenText: '',
    transitionOut: 'cut',
  };

  it('is an optional schema property and prompted sparingly', () => {
    const schema = scriptSchema(['TEXT_CARD']);
    const item = schema.properties.shots.items;
    expect(item.properties).toHaveProperty('sfxCue');
    expect(item.required).not.toContain('sfxCue');
    expect(SCRIPT_SYSTEM_PROMPT).toContain('sfxCue');
  });

  it('keeps a cleaned cue, and null when absent or empty', () => {
    const plan = normaliseScript(
      {
        fullText: 'Hello',
        shots: [
          { ...base, sfxCue: '  Cash <register> ding!  ' },
          { ...base },
          { ...base, sfxCue: '' },
        ],
      },
      ['TEXT_CARD'],
      15,
    );
    expect(plan.shots.map((s) => s.sfxCue)).toEqual(['Cash register ding', null, null]);
  });

  it('normaliseSfxCue caps the length and strips punctuation', () => {
    expect(normaliseSfxCue(undefined)).toBeNull();
    expect(normaliseSfxCue('***')).toBeNull();
    expect(normaliseSfxCue('a'.repeat(100))).toHaveLength(60);
  });
});
