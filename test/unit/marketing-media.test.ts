import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALL_MARKETING_IMAGES,
  FLOW_SCREENS,
  FLOW_STEPS,
  MARKETING_PHOTOS,
} from '@/lib/marketing/media';
import { marketingSrc } from '@/lib/marketing/media-src';

// BACKLOG 20.8 — the landing page's photos and product screens. Every file in public/marketing/
// must be listed (with its source and licence) in public/marketing/SOURCES.md; every image the
// pages use must exist at the size the manifest declares (the img width/height attributes), stay
// small, and be inlined by the demo build's shim.

const ROOT = join(__dirname, '..', '..');
const DIR = join(ROOT, 'public', 'marketing');
const SOURCES = readFileSync(join(DIR, 'SOURCES.md'), 'utf8');
const SHIM = readFileSync(join(ROOT, 'demo', 'shims', 'marketing-media-src.ts'), 'utf8');

/** Largest single file and all files together (bytes). */
const MAX_FILE = 100 * 1024;
const MAX_TOTAL = 1.2 * 1024 * 1024;

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

const onDisk = files(DIR)
  .map((f) => relative(DIR, f).replaceAll('\\', '/'))
  .filter((f) => f !== 'SOURCES.md');

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

  it('has no file that the pages do not use', () => {
    const used = new Set(ALL_MARKETING_IMAGES.map((i) => i.path));
    expect(onDisk.filter((f) => !used.has(f))).toEqual([]);
  });

  it.each(ALL_MARKETING_IMAGES.map((i) => [i.path, i] as const))(
    '%s exists at its declared size and is small',
    (path, image) => {
      const file = join(DIR, path);
      const size = webpSize(readFileSync(file));
      expect(size).toEqual({ width: image.width, height: image.height });
      expect(statSync(file).size).toBeLessThanOrEqual(MAX_FILE);
    },
  );

  it('keeps the total size reasonable', () => {
    const total = onDisk.reduce((n, f) => n + statSync(join(DIR, f)).size, 0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL);
  });

  it('serves them from /marketing and the demo shim inlines each one', () => {
    expect(marketingSrc(MARKETING_PHOTOS.coffee.path)).toBe('/marketing/photos/coffee.webp');
    for (const { path } of ALL_MARKETING_IMAGES) {
      expect(SHIM).toContain(`'../../public/marketing/${path}'`);
      expect(SHIM).toContain(`'${path}':`);
    }
  });

  it('has a light and a dark screen for every flow step', () => {
    expect(FLOW_STEPS).toEqual(['brief', 'script', 'generate', 'review', 'calendar', 'analytics']);
    for (const step of FLOW_STEPS) {
      expect(FLOW_SCREENS[step].light.path).toBe(`screens/${step}-light.webp`);
      expect(FLOW_SCREENS[step].dark.path).toBe(`screens/${step}-dark.webp`);
    }
  });
});
