import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALL_MARKETING_IMAGES,
  ALL_MARKETING_VIDEOS,
  PRODUCT_SCREEN_NAMES,
  PRODUCT_SCREENS,
  STUDIO_CLIPS,
} from '@/lib/marketing/media';
import { marketingSrc } from '@/lib/marketing/media-src';

// BACKLOG 20.8 / 25.5 — the public pages' media. Every file in public/marketing/ must be listed
// (with its source) in public/marketing/SOURCES.md; every image and video the pages use must exist
// at the size the manifest declares (the img/video width and height attributes) and stay small;
// the demo build's shim inlines every image (Studio posters once, as the 720 px WebP) and no video.

const ROOT = join(__dirname, '..', '..');
const DIR = join(ROOT, 'public', 'marketing');
const SOURCES = readFileSync(join(DIR, 'SOURCES.md'), 'utf8');
const SHIM = readFileSync(join(ROOT, 'demo', 'shims', 'marketing-media-src.ts'), 'utf8');

/** Largest single image, all images together, largest video, all videos together (bytes). */
const MAX_IMAGE = 100 * 1024;
const MAX_IMAGES_TOTAL = 2 * 1024 * 1024;
const MAX_VIDEO = 1.6 * 1024 * 1024;
const MAX_VIDEOS_TOTAL = 5 * 1024 * 1024;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/** Pixel size from a WebP header (lossy VP8, lossless VP8L or extended VP8X). */
function webpSize(buf: Buffer): { width: number; height: number } {
  expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
  expect(buf.toString('ascii', 8, 12)).toBe('WEBP');
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  if (chunk === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  expect(chunk).toBe('VP8 ');
  return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
}

/** Pixel size from a JPEG's first start-of-frame marker (SOF0–SOF15, not DHT/JPG/DAC). */
function jpegSize(buf: Buffer): { width: number; height: number } {
  expect(buf.readUInt16BE(0)).toBe(0xffd8);
  let i = 2;
  while (i < buf.length) {
    const marker = buf.readUInt16BE(i);
    const length = buf.readUInt16BE(i + 2);
    if (marker >= 0xffc0 && marker <= 0xffcf && ![0xffc4, 0xffc8, 0xffcc].includes(marker)) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    i += 2 + length;
  }
  throw new Error('no SOF marker');
}

/** Display size of an MP4's video track (the tkhd box with a non-zero width, 16.16 fixed). */
function mp4Size(buf: Buffer): { width: number; height: number } {
  let from = 0;
  for (;;) {
    const at = buf.indexOf('tkhd', from, 'ascii');
    if (at < 0) throw new Error('no video tkhd box');
    const version = buf[at + 4];
    const sizeAt = at + 8 + (version === 1 ? 32 : 20) + 52;
    const width = buf.readUInt32BE(sizeAt) >>> 16;
    const height = buf.readUInt32BE(sizeAt + 4) >>> 16;
    if (width > 0 && height > 0) return { width, height };
    from = at + 4;
  }
}

function imageSize(path: string): { width: number; height: number } {
  const buf = readFileSync(join(DIR, path));
  return path.endsWith('.jpg') ? jpegSize(buf) : webpSize(buf);
}

const onDisk = files(DIR)
  .map((f) => relative(DIR, f).replaceAll('\\', '/'))
  .filter((f) => f !== 'SOURCES.md');
const bytes = (paths: string[]) => paths.reduce((n, f) => n + statSync(join(DIR, f)).size, 0);

describe('public/marketing', () => {
  it('lists every file in SOURCES.md', () => {
    const missing = onDisk.filter((f) => !SOURCES.includes(`\`${f}\``));
    expect(missing).toEqual([]);
  });

  it('records a source URL and the licence for every photo', () => {
    for (const f of onDisk.filter((p) => p.startsWith('photos/'))) {
      const row = SOURCES.split('\n').find((line) => line.includes(`\`${f}\``));
      expect(row, f).toMatch(/\]\(https:\/\/unsplash\.com\/photos\/[\w-]+\)/);
    }
    expect(SOURCES).toContain('https://unsplash.com/license');
    expect(SOURCES).toContain('2026-09-30');
  });

  it('says the Studio clips were made with PostMind Studio and the businesses are fictional', () => {
    expect(SOURCES).toContain(
      'made with PostMind Studio on 2026-10-07 (showcase businesses are fictional)',
    );
  });

  it('has no file that the pages do not use', () => {
    const used = new Set([...ALL_MARKETING_IMAGES, ...ALL_MARKETING_VIDEOS].map((i) => i.path));
    expect(onDisk.filter((f) => !used.has(f))).toEqual([]);
  });

  it.each(ALL_MARKETING_IMAGES.map((i) => [i.path, i] as const))(
    '%s exists at its declared size and is small',
    (path, image) => {
      expect(imageSize(path)).toEqual({ width: image.width, height: image.height });
      expect(statSync(join(DIR, path)).size).toBeLessThanOrEqual(MAX_IMAGE);
    },
  );

  it.each(ALL_MARKETING_VIDEOS.map((v) => [v.path, v] as const))(
    '%s is an MP4 at its declared size and within the video budget',
    (path, video) => {
      const buf = readFileSync(join(DIR, path));
      expect(buf.toString('ascii', 4, 8)).toBe('ftyp');
      expect(mp4Size(buf)).toEqual({ width: video.width, height: video.height });
      expect(buf.length).toBeLessThanOrEqual(MAX_VIDEO);
    },
  );

  it('keeps the totals reasonable', () => {
    expect(bytes(ALL_MARKETING_IMAGES.map((i) => i.path))).toBeLessThanOrEqual(MAX_IMAGES_TOTAL);
    expect(bytes(ALL_MARKETING_VIDEOS.map((v) => v.path))).toBeLessThanOrEqual(MAX_VIDEOS_TOTAL);
  });

  it('gives every Studio clip 9:16 posters at 360, 720 and a 540 JPEG fallback', () => {
    for (const clip of Object.values(STUDIO_CLIPS)) {
      expect(clip.poster.small).toMatchObject({ width: 360, height: 640 });
      expect(clip.poster.large).toMatchObject({ width: 720, height: 1280 });
      expect(clip.poster.fallback).toMatchObject({ width: 540, height: 960 });
      expect(clip.video.width / clip.video.height).toBeCloseTo(9 / 16, 3);
    }
  });

  it('serves them from /marketing; the demo shim inlines every image and no video', () => {
    expect(marketingSrc(STUDIO_CLIPS.seedanceBread.video.path)).toBe(
      '/marketing/studio/seedance-bread.mp4',
    );
    const inlined = ALL_MARKETING_IMAGES.filter(
      (i) => !/^studio\/.+(-360\.webp|\.jpg)$/.test(i.path),
    );
    for (const { path } of inlined) {
      expect(SHIM).toContain(`'../../public/marketing/${path}'`);
      expect(SHIM).toContain(`'${path}':`);
    }
    expect(SHIM).not.toMatch(/\.mp4'/);
  });

  it('has a light and a dark capture for every product screen', () => {
    expect(PRODUCT_SCREEN_NAMES).toEqual(['script', 'generate', 'calendar', 'analytics']);
    for (const name of PRODUCT_SCREEN_NAMES) {
      expect(PRODUCT_SCREENS[name].light.path).toBe(`screens/${name}-light.webp`);
      expect(PRODUCT_SCREENS[name].dark.path).toBe(`screens/${name}-dark.webp`);
    }
  });
});
