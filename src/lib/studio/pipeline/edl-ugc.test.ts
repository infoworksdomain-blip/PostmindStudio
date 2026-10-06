import { describe, expect, it } from 'vitest';
import { overlayClip, type OverlayRow } from '../overlays/shotstack';
import { suggestOverlays } from '../overlays/suggest';
import { captionStyle } from '../overlays/voice-captions';
import {
  buildShotstackComposition,
  MEDIA_FIT,
  MUSIC_UNDER_VOICE_VOLUME,
  SOURCE_AUDIO_VOLUME,
  TOP_HEADLINE_OFFSET_Y,
  UGC_STILL_EFFECT,
} from './edl';
import { evaluateAudioSync } from './quality-sync';

// BACKLOG 21.4 — composition with clip-native speech: a UGC actor clip's own audio is the shot's
// narration (no ElevenLabs voice clip), the music ducks under it, the headline moves to the top,
// and the summary records clip speech for audio_sync.

type Clip = Record<string, unknown> & { asset: Record<string, unknown> };

function clips(edit: Record<string, unknown>): Clip[] {
  const timeline = edit.timeline as { tracks: Array<{ clips: Clip[] }> };
  return timeline.tracks.flatMap((t) => t.clips);
}

const composition = () =>
  buildShotstackComposition({
    aspectRatio: '9:16',
    musicSrc: 'https://s3.test/music.mp3',
    musicDurationSec: 60,
    shots: [
      {
        id: 'actor-1',
        durationSec: 8,
        visualTreatment: 'UGC_ACTOR',
        visualSrc: 'https://s3.test/actor.mp4',
        visualKind: 'video',
        clipSpeech: true,
        onScreenText: 'Mornings, sorted',
      },
      {
        id: 'still-1',
        durationSec: 3,
        visualTreatment: 'IMAGE_STILL',
        visualSrc: 'https://s3.test/product.png',
        visualKind: 'image',
      },
      {
        id: 'broll-1',
        durationSec: 4,
        visualTreatment: 'AI_CLIP',
        visualSrc: 'https://s3.test/ai.mp4',
        visualKind: 'video',
        voiceSrc: 'https://s3.test/voice.mp3',
      },
    ],
  });

describe('UGC actor clips in the edit (21.4)', () => {
  it('plays the actor clip’s own audio and still mutes other generated clips', () => {
    const videos = clips(composition().edit).filter((c) => c.asset.type === 'video');
    expect(videos.map((c) => c.asset.volume)).toEqual([SOURCE_AUDIO_VOLUME, 0]);
  });

  it('lays no separate voice clip for the actor (only the narrated B-roll has one)', () => {
    const audio = clips(composition().edit).filter(
      (c) => c.asset.type === 'audio' && String(c.asset.src).includes('voice'),
    );
    expect(audio).toHaveLength(1);
    expect(audio[0]).toMatchObject({ start: 11 });
  });

  it('21.4a: draws no headline box over the actor’s face (the words are captioned)', () => {
    const headline = clips(composition().edit).find((c) =>
      String(c.asset.html ?? '').includes('Mornings, sorted'),
    );
    expect(headline).toBeUndefined();
  });

  it('a narrated B-roll shot in the same video still gets its headline at the top', () => {
    const edit = buildShotstackComposition({
      aspectRatio: '9:16',
      shots: [
        {
          id: 'broll',
          durationSec: 4,
          visualTreatment: 'AI_CLIP',
          visualSrc: 'https://s3.test/ai.mp4',
          visualKind: 'video',
          voiceSrc: 'https://s3.test/voice.mp3',
          onScreenText: 'Two minutes, done',
        },
      ],
    }).edit;
    const headline = clips(edit).find((c) =>
      String(c.asset.html ?? '').includes('Two minutes, done'),
    );
    expect(headline).toMatchObject({ position: 'top', offset: { x: 0, y: TOP_HEADLINE_OFFSET_Y } });
  });

  it('ducks the music under the actor’s speech', () => {
    const music = clips(composition().edit).filter(
      (c) => c.asset.type === 'audio' && String(c.asset.src).includes('music'),
    );
    expect(music[0]?.asset.volume).toBe(MUSIC_UNDER_VOICE_VOLUME);
  });

  it('records clip speech in the summary for audio_sync', () => {
    const { summary } = composition();
    expect(summary.shots[0]).toMatchObject({
      shotId: 'actor-1',
      treatment: 'UGC_ACTOR',
      voiceClipSec: 8,
      speech: 'clip',
    });
    expect(summary.shots[1]).toMatchObject({ voiceClipSec: null });
    expect(summary.shots[1]).not.toHaveProperty('speech');
    expect(summary.shots[2]).not.toHaveProperty('speech');
  });
});

describe('21.4b: a UGC edit has no boxes over the creator or the B-roll', () => {
  const ugcShots = [
    {
      id: 'actor-1',
      durationSec: 8,
      visualTreatment: 'UGC_ACTOR' as const,
      visualSrc: 'https://s3.test/actor.mp4',
      visualKind: 'video' as const,
      clipSpeech: true,
      onScreenText: 'Client calls?',
    },
    {
      id: 'still-1',
      durationSec: 3,
      visualTreatment: 'IMAGE_STILL' as const,
      visualSrc: 'https://s3.test/product.png',
      visualKind: 'image' as const,
      onScreenText: 'Preps your opener',
    },
    {
      id: 'still-2',
      durationSec: 2,
      visualTreatment: 'IMAGE_STILL' as const,
      visualSrc: 'https://s3.test/product-2.png',
      visualKind: 'image' as const,
    },
  ];
  const built = buildShotstackComposition({
    aspectRatio: '9:16',
    shots: ugcShots,
    aiLabel: true,
    ugc: true,
  });

  /** The overlays a UGC project gets: suggested labels plus the actor's captions. */
  const overlays = (): OverlayRow[] => {
    const labels = suggestOverlays(
      ugcShots.map((s, i) => ({
        ...s,
        sortOrder: i,
        voiceoverText: null,
        onScreenText: s.onScreenText ?? null,
      })),
      { primary: '#111111', secondary: '#1A1A40', fontFamily: 'Lora' },
      () => 'subtitle_box',
      { ugc: true },
    );
    const caption = captionStyle('tiktok', { primary: '#111111' }, { ugc: true });
    return [
      ...labels.map((l, i) => ({
        id: `label-${i}`,
        text: l.text,
        startAtSec: 0,
        endAtSec: 2,
        ...l.style,
      })),
      ...(caption
        ? [
            {
              id: 'cap',
              text: 'used to dread client',
              startAtSec: 0.2,
              endAtSec: 1.4,
              ...caption.style,
            },
          ]
        : []),
    ];
  };

  it('draws no headline HTML box on any UGC shot (the AI label is the only HTML asset)', () => {
    const html = clips(built.edit).filter((c) => c.asset.type === 'html');
    // The one HTML asset is the required AI-generated label (left as it is).
    expect(html).toHaveLength(1);
    expect(built.summary.brand.aiLabel).toBe(true);
    expect(html.every((c) => !String(c.asset.html).includes('Preps your opener'))).toBe(true);
    expect(html.every((c) => !String(c.asset.html).includes('Client calls?'))).toBe(true);
  });

  it('labels and captions become outlined rich-text with no background', () => {
    const frame = { width: 1080, height: 1920 };
    const rows = overlays();
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      const clip = overlayClip(row, { frame, offsetSec: 0 }) as { asset: Record<string, unknown> };
      expect(clip.asset.type).toBe('rich-text');
      expect(clip.asset.background).toBeUndefined();
      expect(clip.asset.stroke).toEqual({ width: 3, color: '#000000', opacity: 1 });
      expect((clip.asset.font as { color: string }).color).toBe('#ffffff');
    }
  });

  it('every UGC still pushes in, full frame', () => {
    const stills = clips(built.edit).filter((c) => c.asset.type === 'image');
    expect(stills).toHaveLength(2);
    for (const s of stills) expect(s).toMatchObject({ fit: MEDIA_FIT, effect: UGC_STILL_EFFECT });
  });

  it('an ordinary video keeps its boxed headline and alternating Ken Burns', () => {
    const plain = buildShotstackComposition({ aspectRatio: '9:16', shots: ugcShots.slice(1) });
    const headline = clips(plain.edit).find((c) =>
      String(c.asset.html ?? '').includes('Preps your opener'),
    );
    expect(String(headline?.asset.css)).toContain('rgba(0,0,0,0.45)');
    const effects = clips(plain.edit)
      .filter((c) => c.asset.type === 'image')
      .map((c) => c.effect);
    expect(effects).toEqual(['zoomIn', 'zoomOut']);
  });
});

describe('audio_sync with clip speech (21.4)', () => {
  const { summary } = composition();
  const fit = (voiceSec: number) => ({
    strategy: 'fits' as const,
    voiceSec,
    shotSec: 8,
  });
  const narration = [
    { shotId: 'broll-1', fit: { strategy: 'fits' as const, voiceSec: 3.5, shotSec: 4 } },
  ];

  it('passes when the actor’s last word ends inside the shot', () => {
    const check = evaluateAudioSync(summary, [{ shotId: 'actor-1', fit: fit(7.4) }, ...narration]);
    expect(check).toMatchObject({ status: 'passed', detailParams: { count: 2 } });
  });

  it('fails when the line runs past the shot (a clip cannot be trimmed or re-paced)', () => {
    const check = evaluateAudioSync(summary, [
      {
        shotId: 'actor-1',
        fit: { strategy: 'trim', voiceSec: 8.6, shotSec: 8, trimSec: 7.9, wordBoundary: true },
      },
      ...narration,
    ]);
    expect(check.status).toBe('failed');
    expect(check.detail).toContain("the actor's line runs 8.60s in a 8.00s shot");
    expect(check.detailParams).toMatchObject({ shots: '1' });
  });

  it('fails when the actor’s speech was never measured', () => {
    const check = evaluateAudioSync(summary, [
      { shotId: 'actor-1', fit: { strategy: 'unmeasured', voiceSec: null, shotSec: 8 } },
      ...narration,
    ]);
    expect(check.status).toBe('failed');
  });
});
