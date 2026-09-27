import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFfmpegInspector } from '../../src/lib/studio/pipeline/media-probe';

// Real ffmpeg/ffprobe against generated clips (CI installs ffmpeg from Ubuntu's repository).
// Skipped where ffmpeg is not installed.

const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const hasFfmpeg = spawnSync(ffmpeg, ['-version']).status === 0;

describe.skipIf(!hasFfmpeg)('ffmpeg media inspector', { timeout: 60_000 }, () => {
  let dir: string;
  let normal: string;
  let blackSilent: string;
  const inspector = createFfmpegInspector();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-media-'));
    normal = join(dir, 'normal.mp4');
    blackSilent = join(dir, 'black.mp4');
    // 3s 9:16 test pattern with a 440Hz tone, H.264 + AAC in MP4.
    execFileSync(
      ffmpeg,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=360x640:rate=30:duration=3',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=3',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        normal,
      ],
      { stdio: 'ignore' },
    );
    // 2s solid black, no audio stream.
    execFileSync(
      ffmpeg,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:size=360x640:rate=30:duration=2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        blackSilent,
      ],
      { stdio: 'ignore' },
    );
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('probes duration, size, codecs and container', async () => {
    const probe = await inspector.probe(normal);
    expect(probe.durationSec).toBeCloseTo(3, 0);
    expect(probe).toMatchObject({ width: 360, height: 640, videoCodec: 'h264', audioCodec: 'aac' });
    expect(probe.fps).toBeCloseTo(30, 0);
    expect(probe.formatName.split(',')).toContain('mp4');
  });

  it('detects black segments and ignores normal footage', async () => {
    expect(await inspector.blackIntervals(normal, 0.5)).toEqual([]);
    const black = await inspector.blackIntervals(blackSilent, 0.5);
    expect(black[0]?.durationSec).toBeGreaterThan(1.5);
  });

  it('measures integrated loudness, or null without audio', async () => {
    const lufs = await inspector.integratedLoudness(normal);
    expect(lufs).not.toBeNull();
    expect(lufs!).toBeLessThan(0);
    expect(await inspector.integratedLoudness(blackSilent)).toBeNull();
  });

  it('reports a missing binary as a configuration error', async () => {
    const missing = createFfmpegInspector({ ffprobePath: 'definitely-not-ffprobe' });
    await expect(missing.probe(normal)).rejects.toThrow(/not found/);
  });
});
