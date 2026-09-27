import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageSize } from 'image-size';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFfmpegInspector } from '../../src/lib/studio/pipeline/media-probe';

// BACKLOG 9.1 against real ffmpeg (CI): scene detection finds a hard cut and frame grabs are
// JPEGs scaled to the requested width. Skipped where ffmpeg is not installed.

const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const hasFfmpeg = spawnSync(ffmpeg, ['-version']).status === 0;

describe.skipIf(!hasFfmpeg)('ffmpeg scene detection + frame grabs', { timeout: 60_000 }, () => {
  let dir: string;
  let clip: string;
  const inspector = createFfmpegInspector();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-scenes-'));
    clip = join(dir, 'cut.mp4');
    // 2s red, then 2s blue: one hard cut at 2s.
    execFileSync(
      ffmpeg,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=360x640:r=30:d=2',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=360x640:r=30:d=2',
        '-filter_complex',
        '[0:v][1:v]concat=n=2:v=1:a=0',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        clip,
      ],
      { stdio: 'ignore' },
    );
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('finds the cut', async () => {
    const cuts = await inspector.sceneChanges(clip, 0.3);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toBeCloseTo(2, 0);
  });

  it('renders a low-res muted preview rendition', async () => {
    const bytes = await inspector.previewClip(clip, 180, 3);
    const file = join(dir, 'preview.mp4');
    writeFileSync(file, bytes);
    const probe = await inspector.probe(file);
    expect(probe).toMatchObject({ width: 180, height: 320, audioCodec: null, videoCodec: 'h264' });
    expect(probe.durationSec).toBeLessThanOrEqual(3.1);
  });

  it('grabs a scaled JPEG frame', async () => {
    const jpeg = await inspector.frameJpeg(clip, 1, 180);
    expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
    expect(imageSize(jpeg)).toMatchObject({ type: 'jpg', width: 180, height: 320 });
  });
});
