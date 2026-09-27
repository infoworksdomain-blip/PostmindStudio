import { describe, expect, it } from 'vitest';
import { buildShotstackEdit, SOURCE_AUDIO_VOLUME } from './edl';
import { buildSlideshowEdit, type ResolvedSlide } from '../slideshow/edl';

// 13.5 / 13.4 additions to the edit decision lists.

function clips(edit: Record<string, unknown>) {
  const timeline = edit.timeline as { tracks: Array<{ clips: Array<Record<string, unknown>> }> };
  return timeline.tracks.flatMap((t) => t.clips);
}

describe('uploaded clips keep their own audio', () => {
  it('plays an uploaded clip at full volume and mutes generated clips', () => {
    const edit = buildShotstackEdit({
      aspectRatio: '9:16',
      shots: [
        {
          durationSec: 10,
          visualTreatment: 'USER_UPLOAD',
          visualSrc: 'https://s3.test/upload.mp4',
          visualKind: 'video',
          keepSourceAudio: true,
        },
        {
          durationSec: 4,
          visualTreatment: 'AI_CLIP',
          visualSrc: 'https://s3.test/ai.mp4',
          visualKind: 'video',
        },
      ],
    });
    const videos = clips(edit).filter((c) => (c.asset as { type: string }).type === 'video');
    expect(videos.map((c) => (c.asset as { volume: number }).volume)).toEqual([
      SOURCE_AUDIO_VOLUME,
      0,
    ]);
  });
});

describe('slides with styled overlays', () => {
  const slide: ResolvedSlide = {
    slideType: 'IMAGE_STILL',
    durationSec: 2.5,
    transitionIn: null,
    imageSrc: 'https://s3.test/1.png',
    backgroundColor: null,
    content: { number: 1, text: 'Slow ferment' },
  };

  it('drops the plain caption band when the slide has overlays', () => {
    const plain = JSON.stringify(buildSlideshowEdit({ aspectRatio: '9:16', slides: [slide] }));
    const styled = JSON.stringify(
      buildSlideshowEdit({ aspectRatio: '9:16', slides: [{ ...slide, hasOverlays: true }] }),
    );
    expect(plain).toContain('Slow ferment');
    expect(styled).not.toContain('Slow ferment');
  });
});
