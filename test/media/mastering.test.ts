import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFfmpegMastering, planMastering } from '../../src/lib/studio/pipeline/mastering';
import { createFfmpegInspector } from '../../src/lib/studio/pipeline/media-probe';

// BACKLOG 13.26 against real ffmpeg (CI installs it): a quiet VP9/WebM clip is normalised to
// -14 LUFS and re-encoded to an H.264 Baseline MP4, which then passes the gate's checks.
// Skipped where ffmpeg is not installed.

const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const hasFfmpeg = spawnSync(ffmpeg, ['-version']).status === 0;

describe.skipIf(!hasFfmpeg)('ffmpeg mastering', { timeout: 120_000 }, () => {
  let dir: string;
  let quietWebm: string;
  const inspector = createFfmpegInspector();
  const mastering = createFfmpegMastering();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-master-test-'));
    quietWebm = join(dir, 'quiet.webm');
    execFileSync(
      ffmpeg,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=360x640:rate=30:duration=4',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=4,volume=0.02',
        '-c:v',
        'libvpx-vp9',
        '-b:v',
        '200k',
        '-c:a',
        'libopus',
        '-shortest',
        quietWebm,
      ],
      { stdio: 'ignore' },
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('normalises loudness and re-encodes to an H.264 MP4 the gate accepts', async () => {
    const before = await inspector.probe(quietWebm);
    const loudness = await inspector.integratedLoudness(quietWebm);
    const plan = planMastering(before, loudness);
    expect(plan).toMatchObject({ normaliseAudio: true, reencodeVideo: true });
    const measured = await mastering.measure(quietWebm);
    expect(measured.inputI).toBeLessThan(-18);
    const out = join(dir, 'mastered.mp4');
    writeFileSync(out, await mastering.master(quietWebm, plan, measured));
    const after = await inspector.probe(out);
    expect(after.videoCodec).toBe('h264');
    expect(after.videoProfile).toMatch(/Baseline/);
    expect(after.formatName.split(',')).toContain('mp4');
    const lufs = await inspector.integratedLoudness(out);
    expect(lufs).not.toBeNull();
    expect(Math.abs((lufs ?? 0) + 14)).toBeLessThan(2);
  });
});
