import { describe, expect, it } from 'vitest';
import { PREVIEW_FILE, previewClipArgs } from './media-probe';

// BACKLOG 20.17 — library previews keep their sound (operator decision 2026-10-01). The real
// ffmpeg run (with and without an audio stream) is covered in test/media/scenes.test.ts.

describe('previewClipArgs', () => {
  const args = previewClipArgs('https://bucket.test/library/abc.mp4?sig=1', 360, 30);

  function valueAfter(flag: string): string | undefined {
    return args[args.indexOf(flag) + 1];
  }

  it('encodes the audio as AAC stereo at a modest bitrate and never drops it', () => {
    expect(args).not.toContain('-an');
    expect(valueAfter('-c:a')).toBe('aac');
    expect(valueAfter('-b:a')).toBe('96k');
    expect(valueAfter('-ac')).toBe('2');
  });

  it('maps the first video stream and the first audio stream only when there is one', () => {
    const maps = args.flatMap((a, i) => (a === '-map' ? [args[i + 1]] : []));
    expect(maps).toEqual(['0:v:0', '0:a:0?']);
  });

  it('keeps the A3.10 limits: 360 px wide at most, 30 s at most, faststart MP4', () => {
    expect(valueAfter('-i')).toBe('https://bucket.test/library/abc.mp4?sig=1');
    expect(valueAfter('-t')).toBe('30.000');
    expect(valueAfter('-vf')).toBe("scale='min(360,iw)':-2,fps=15");
    expect(valueAfter('-c:v')).toBe('libx264');
    expect(valueAfter('-movflags')).toBe('+faststart');
    expect(args.at(-1)).toBe(PREVIEW_FILE);
  });
});
