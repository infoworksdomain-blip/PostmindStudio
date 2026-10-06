import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFfmpegInspector } from '../../src/lib/studio/pipeline/media-probe';
import { LUFS_RANGE } from '../../src/lib/studio/pipeline/quality-checks';
import { createLocalRenderer } from '../../src/lib/studio/render/local/renderer';
import { slideshowEdit, wallOfTextEdit } from '../helpers/local-render-fixtures';

// BACKLOG 23.5 — the local renderer against real ffmpeg (CI installs it; skipped where it is not
// installed): a slideshow and a wall of text from the composer's own builders, rendered from tiny
// generated inputs, then probed like the quality gate does: duration, frame size, codecs, no
// black frames (the gate's blackdetect), loudness inside the gate window.

const hasFfmpeg = spawnSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-version']).status === 0;

describe.skipIf(!hasFfmpeg)('local ffmpeg renderer (real ffmpeg)', { timeout: 300_000 }, () => {
  let dir = '';
  const media = new Map<string, { body: Buffer<ArrayBuffer>; type: string }>();
  const fetchImpl = (async (url: string | URL | Request) => {
    const hit = media.get(String(url));
    return hit
      ? new Response(hit.body, { headers: { 'content-type': hit.type } })
      : new Response('missing', { status: 404 });
  }) as typeof fetch;

  function ffmpeg(args: string[]): void {
    const r = spawnSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-hide_banner', '-y', ...args], {
      cwd: dir,
    });
    if (r.status !== 0)
      throw new Error(`fixture ffmpeg failed: ${r.stderr.toString().slice(-500)}`);
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'local-render-it-'));
    const picture = (r: number, g: number, b: number) =>
      sharp({ create: { width: 640, height: 480, channels: 3, background: { r, g, b } } })
        .jpeg()
        .toBuffer();
    media.set('https://img.test/a.jpg', { body: await picture(200, 120, 40), type: 'image/jpeg' });
    media.set('https://img.test/b.jpg', { body: await picture(40, 140, 200), type: 'image/jpeg' });
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x240:rate=30:duration=3',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      'bg.mp4',
    ]);
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:a', 'aac', 'music.m4a']);
    media.set('https://video.test/calm.mp4', {
      body: await readFile(path.join(dir, 'bg.mp4')),
      type: 'video/mp4',
    });
    media.set('https://music.test/bed.mp3', {
      body: await readFile(path.join(dir, 'music.m4a')),
      type: 'audio/mp4',
    });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function renderAndProbe(edit: Record<string, unknown>, name: string) {
    const out = await createLocalRenderer().render(edit, { fetch: fetchImpl });
    const file = path.join(dir, `${name}.mp4`);
    await writeFile(file, out.bytes);
    const inspector = createFfmpegInspector();
    // Render time in the CI log (the 23.5 target: ≤ 15 s for a 10–15 s 1080×1920 video on 2 vCPU).
    process.stdout.write(
      `23.5 local render ${name}: ${out.renderMs} ms; notes: ${out.notes.join('; ') || 'none'}\n`,
    );
    return {
      out,
      probe: await inspector.probe(file),
      black: await inspector.blackIntervals(file, 0.5),
      loudness: await inspector.integratedLoudness(file),
    };
  }

  it('renders a 9:16 slideshow: 1080×1920, 8 s, H.264 + AAC, never black, loudness in the gate window', async () => {
    const { out, probe, black, loudness } = await renderAndProbe(
      slideshowEdit('9:16'),
      'slideshow',
    );
    expect(probe).toMatchObject({
      width: 1080,
      height: 1920,
      videoCodec: 'h264',
      audioCodec: 'aac',
    });
    expect(probe.formatName.split(',')).toContain('mp4');
    expect(probe.durationSec).toBeGreaterThan(7.9);
    expect(probe.durationSec).toBeLessThan(8.15);
    expect(Math.round(probe.fps)).toBe(30);
    expect(black).toEqual([]);
    expect(loudness).not.toBeNull();
    expect(loudness as number).toBeGreaterThanOrEqual(LUFS_RANGE[0]);
    expect(loudness as number).toBeLessThanOrEqual(LUFS_RANGE[1]);
    expect(out.measuredLufs).not.toBeNull();
  });

  it('renders a 16:9 wall of text over a looped, letterbox-cropped background', async () => {
    const { probe, black } = await renderAndProbe(wallOfTextEdit('16:9'), 'wall-16x9');
    expect(probe).toMatchObject({
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
    });
    // The 3 s clip loops to fill the 8 s video.
    expect(probe.durationSec).toBeGreaterThan(7.9);
    expect(black).toEqual([]);
  });
});
