import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { slideshowEdit, wallOfTextEdit } from '../../../../../test/helpers/local-render-fixtures';
import { UpstreamServiceError } from '../../../errors';
import { KEN_BURNS_SUPERSAMPLE, placeOnFrame, prepareTimeline, withOpacity } from './prepare';
import { readTimeline, type LocalTimeline } from './timeline';

async function photo(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } } })
    .jpeg()
    .toBuffer();
}

function fakeFetch(bodies: Record<string, { body: Buffer; type: string }>) {
  return vi.fn(async (url: string | URL | Request) => {
    const hit = bodies[String(url)];
    if (!hit) return new Response('missing', { status: 404 });
    return new Response(new Uint8Array(hit.body), { headers: { 'content-type': hit.type } });
  });
}

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'local-prepare-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('prepareTimeline', () => {
  it('resizes slideshow photos to the frame (Ken Burns supersampled), draws cards, downloads once', async () => {
    const fetchImpl = fakeFetch({
      'https://img.test/a.jpg': { body: await photo(1280, 853), type: 'image/jpeg' },
      'https://img.test/b.jpg': { body: await photo(640, 480), type: 'image/jpeg' },
      'https://music.test/bed.mp3': { body: Buffer.from([1, 2, 3]), type: 'audio/mpeg' },
    });
    const timeline = readTimeline(slideshowEdit());
    const { prepared, notes } = await prepareTimeline(timeline, {
      dir,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(prepared.base.map((b) => [b.kind, b.file])).toEqual([
      ['still', 'card-0.png'],
      ['kenBurns', 'kb-1.jpg'],
      ['still', 'still-2.jpg'],
    ]);
    const kb = await sharp(path.join(dir, 'kb-1.jpg')).metadata();
    expect([kb.width, kb.height]).toEqual([
      1080 * KEN_BURNS_SUPERSAMPLE,
      1920 * KEN_BURNS_SUPERSAMPLE,
    ]);
    const still = await sharp(path.join(dir, 'still-2.jpg')).metadata();
    expect([still.width, still.height]).toEqual([1080, 1920]);
    const card = await sharp(path.join(dir, 'card-0.png'))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([card.info.width, card.info.height]).toEqual([1080, 1920]);
    expect(Array.from(card.data.subarray(0, 3))).toEqual([0x3a, 0x41, 0x50]); // the slate backdrop
    // Captions: bottom band, 90 % wide, centred.
    expect(prepared.layers).toEqual([
      { kind: 'image', file: 'layer-0.png', x: 54, y: expect.any(Number) },
      { kind: 'image', file: 'layer-1.png', x: 54, y: expect.any(Number) },
    ]);
    expect(prepared.audio).toEqual(['in-3.mp3']);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(notes).toContain('font Arial drawn in Inter');
    expect((await readdir(dir)).sort()).toEqual(
      [
        'card-0.png',
        'in-1.media',
        'in-2.media',
        'in-3.mp3',
        'kb-1.jpg',
        'layer-0.png',
        'layer-1.png',
        'still-2.jpg',
      ].sort(),
    );
  });

  it('keeps the background clip as a download and places the label at the top', async () => {
    const fetchImpl = fakeFetch({
      'https://video.test/calm.mp4': { body: Buffer.from('video'), type: 'video/mp4' },
      'https://music.test/bed.mp3': { body: Buffer.from('music'), type: 'audio/mpeg' },
    });
    const { prepared } = await prepareTimeline(readTimeline(wallOfTextEdit()), {
      dir,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(prepared.base).toEqual([
      {
        kind: 'video',
        file: 'in-1.mp4',
        fit: 'cover',
        trimSec: 0,
        crop: { top: 0.1, bottom: 0.1, left: 0, right: 0 },
      },
    ]);
    const label = prepared.layers[0];
    // 40 % wide, centred, 2 % below the top (offset y −0.02).
    expect(label).toEqual({ kind: 'image', file: 'layer-0.png', x: 324, y: 38 });
    expect(await readFile(path.join(dir, 'in-1.mp4'), 'utf8')).toBe('video');
  });

  it('places a logo (fit contain, scale, opacity) and rotates a layer about its centre', async () => {
    const logo = await sharp({
      create: {
        width: 200,
        height: 100,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const fetchImpl = fakeFetch({
      'https://brand.test/logo.png': { body: logo, type: 'image/png' },
    });
    const base = readTimeline(wallOfTextEdit('9:16', { aiLabel: false }));
    const timeline: LocalTimeline = {
      ...base,
      audio: [],
      base: [],
      layers: [
        {
          source: {
            kind: 'image',
            src: 'https://brand.test/logo.png',
            fit: 'contain',
            kenBurns: null,
          },
          startSec: 0,
          endSec: 8,
          position: 'topRight',
          offsetX: -0.03,
          offsetY: -0.03,
          scale: 0.12,
          opacity: 0.5,
          fadeInSec: 0,
          fadeOutSec: 0,
          rotationDeg: 90,
          motion: { slideIn: null, slideOut: null, wave: null },
        },
      ],
    };
    const { prepared } = await prepareTimeline(timeline, {
      dir,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const out = await sharp(path.join(dir, 'layer-0.png'))
      .raw()
      .toBuffer({ resolveWithObject: true });
    // contain → 1080 wide × 0.12 = 130 × 65, rotated to 65 × 130.
    expect([out.info.width, out.info.height]).toEqual([65, 130]);
    expect(out.data[3]).toBe(128);
    expect(prepared.layers[0]).toEqual({ kind: 'image', file: 'layer-0.png', x: 950, y: 25 });
    // Same centre as unrotated: (918 + 65, 58 + 32.5) → the 65 × 130 picture at (950, 25).
  });

  it('fails clearly when an input cannot be downloaded', async () => {
    const fetchImpl = fakeFetch({});
    await expect(
      prepareTimeline(readTimeline(wallOfTextEdit()), {
        dir,
        fetch: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(UpstreamServiceError);
  });
});

describe('placement helpers', () => {
  it('applies Shotstack offsets (y positive upwards)', () => {
    expect(
      placeOnFrame(
        { position: 'bottom', offsetX: 0.1, offsetY: 0.1 },
        { width: 100, height: 100 },
        { width: 1000, height: 2000 },
      ),
    ).toEqual({
      x: 550,
      y: 1700,
    });
  });

  it('scales alpha for opacity and leaves opaque layers alone', async () => {
    const png = await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
    })
      .png()
      .toBuffer();
    expect(await withOpacity(png, 1)).toBe(png);
    const { data } = await sharp(await withOpacity(png, 0.25))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(64);
  });
});
