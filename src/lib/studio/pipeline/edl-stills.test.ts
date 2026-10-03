import { describe, expect, it } from 'vitest';
import type { AspectRatio } from '../providers/interface';
import {
  buildShotstackComposition,
  MEDIA_FIT,
  outputDimensions,
  STILL_EFFECTS,
  type EdlShot,
} from './edl';
import { isTooDark } from './edl-backdrop';

// BACKLOG 20.25 — a video mixing AI clips with image and motion-graphics shots (the AI clip
// budget's cheaper shots). Clips and stills fill the frame WITHOUT distortion: Shotstack's Clip
// `fit` "crop (default) - scale the asset to fill the viewport while maintaining the aspect ratio"
// (https://shotstack.io/docs/api/#tocs_clip; "cover" stretches without keeping it), with a Ken
// Burns move that never shrinks the picture below the frame, so blackdetect sees no letterbox
// bars; cards sit on a full-frame, non-black fill.

type Clip = { asset: Record<string, unknown>; start: number; length: number } & Record<
  string,
  unknown
>;
type Edit = { timeline: { background: string; tracks: Array<{ clips: Clip[] }> } };

const clipsOf = (edit: Record<string, unknown>) =>
  (edit as unknown as Edit).timeline.tracks.flatMap((t) => t.clips);

const SHOTS: EdlShot[] = [
  {
    durationSec: 4,
    visualTreatment: 'AI_CLIP',
    visualSrc: 'https://s/clip1.mp4',
    visualKind: 'video',
  },
  {
    durationSec: 3,
    visualTreatment: 'IMAGE_STILL',
    visualSrc: 'https://s/a.png',
    visualKind: 'image',
  },
  {
    durationSec: 3,
    visualTreatment: 'MOTION_GRAPHICS',
    onScreenText: 'Baked at dawn',
    cardText: 'Baked at dawn',
  },
  {
    durationSec: 3,
    visualTreatment: 'IMAGE_STILL',
    visualSrc: 'https://s/b.png',
    visualKind: 'image',
  },
  {
    durationSec: 3,
    visualTreatment: 'IMAGE_STILL',
    visualSrc: 'https://s/c.png',
    visualKind: 'image',
  },
  {
    durationSec: 4,
    visualTreatment: 'AI_CLIP',
    visualSrc: 'https://s/clip2.mp4',
    visualKind: 'video',
  },
  { durationSec: 3, visualTreatment: 'TEXT_CARD', cardText: 'Subscribe today' },
];

describe('EDL for image + motion shots (20.25)', () => {
  const { edit, summary } = buildShotstackComposition({ aspectRatio: '9:16', shots: SHOTS });
  const clips = clipsOf(edit);

  it('stills fill the frame (crop) and alternate a push in and a pull out', () => {
    const stills = clips.filter((c) => c.asset.type === 'image');
    expect(stills.map((c) => c.asset.src)).toEqual([
      'https://s/a.png',
      'https://s/b.png',
      'https://s/c.png',
    ]);
    expect(stills.map((c) => c.fit)).toEqual(['crop', 'crop', 'crop']);
    expect(MEDIA_FIT).toBe('crop');
    expect(stills.map((c) => c.effect)).toEqual(['zoomIn', 'zoomOut', 'zoomIn']);
    expect(STILL_EFFECTS).toEqual(['zoomIn', 'zoomOut']);
    // Stills start and end where their shots do (4–7, 10–13, 13–16 s).
    expect(stills.map((c) => [c.start, c.length])).toEqual([
      [4, 3],
      [10, 3],
      [13, 3],
    ]);
  });

  it.each(['9:16', '16:9', '1:1', '4:5'] as const)(
    '%s render: every clip and still keeps its aspect ratio and fills the frame (crop)',
    (aspectRatio: AspectRatio) => {
      // Mixed sources: portrait and landscape clips, an avatar, an upload and stills of any shape.
      const shots: EdlShot[] = [
        ...SHOTS,
        {
          durationSec: 3,
          visualTreatment: 'AI_AVATAR',
          visualSrc: 'https://s/av.mp4',
          visualKind: 'video',
        },
        {
          durationSec: 3,
          visualTreatment: 'USER_UPLOAD',
          visualSrc: 'https://s/up.mp4',
          visualKind: 'video',
          keepSourceAudio: true,
        },
      ];
      const built = buildShotstackComposition({ aspectRatio, shots });
      const media = clipsOf(built.edit).filter(
        (c) => c.asset.type === 'image' || c.asset.type === 'video',
      );
      expect(media).toHaveLength(7);
      for (const clip of media) expect(clip.fit).toBe('crop');
      expect(media.some((c) => c.fit === 'cover' || c.fit === 'contain')).toBe(false);
      expect(built.summary.frame).toEqual(outputDimensions(aspectRatio));
      expect((built.edit as { output: { aspectRatio: string } }).output.aspectRatio).toBe(
        aspectRatio,
      );
    },
  );

  it('the motion-graphics and text cards are full-frame, non-black fills', () => {
    const frame = summary.frame;
    const fills = clips.filter(
      (c) => c.asset.width === frame.width && c.asset.height === frame.height,
    );
    const covering = (start: number, end: number) =>
      fills.find((c) => c.start <= start + 1e-6 && c.start + c.length >= end - 1e-6);
    for (const [start, end] of [
      [7, 10],
      [20, 23],
    ] as const) {
      const fill = covering(start, end);
      expect(fill, `fill over ${start}–${end}s`).toBeDefined();
      const colour =
        fill?.asset.type === 'shape'
          ? (fill.asset.fill as { color: string }).color
          : String(fill?.asset.background);
      expect(isTooDark(colour)).toBe(false);
    }
    expect(isTooDark((edit as unknown as Edit).timeline.background)).toBe(false);
  });

  it('records each shot and the total length in the summary', () => {
    expect(summary.totalSec).toBe(23);
    expect(summary.shots.map((s) => s.treatment)).toEqual(SHOTS.map((s) => s.visualTreatment));
  });

  it('an IMAGE_STILL shot without an image is drawn as a card, not left empty', () => {
    const built = buildShotstackComposition({
      aspectRatio: '9:16',
      shots: [{ durationSec: 3, visualTreatment: 'IMAGE_STILL', onScreenText: 'Fresh' }],
    });
    const { width, height } = built.summary.frame;
    const card = clipsOf(built.edit).find(
      (c) => c.asset.type === 'html' && c.asset.width === width && c.asset.height === height,
    );
    expect(card?.asset.background).toBeDefined();
    expect(isTooDark(String(card?.asset.background))).toBe(false);
  });
});
