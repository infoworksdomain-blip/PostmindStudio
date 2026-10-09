import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import manifest, { CANVAS_HEX } from './manifest';

// 26.2 — the manifest names the product, uses the Daylight canvas colour and points at icons
// that exist; /favicon.ico is a real ICO.

const ROOT = join(__dirname, '..', '..');

describe('web app manifest', () => {
  it('names the product and uses the canvas token colour', () => {
    const m = manifest();
    expect(m.name).toBe('PostMind Studio');
    expect(m.short_name).toBeTruthy();
    expect(m.theme_color).toBe(CANVAS_HEX);
    expect(m.background_color).toBe(CANVAS_HEX);
  });

  it('lists the brand icons at 192 and 512 px, and they exist in public/brand', async () => {
    const icons = manifest().icons ?? [];
    expect(icons.map((i) => i.sizes)).toEqual(['192x192', '512x512']);
    for (const icon of icons) {
      const file = join(ROOT, 'public', icon.src);
      expect(existsSync(file), icon.src).toBe(true);
      const meta = await sharp(file).metadata();
      expect(`${meta.width}x${meta.height}`).toBe(icon.sizes);
      expect(meta.hasAlpha).toBe(true);
    }
  });
});

describe('app icons (Next file conventions)', () => {
  it('icon.png is the 512 px transparent brand icon; apple-icon.png is 180 px and opaque', async () => {
    const icon = await sharp(join(ROOT, 'src/app/icon.png')).metadata();
    expect([icon.width, icon.height, icon.hasAlpha]).toEqual([512, 512, true]);
    const apple = await sharp(join(ROOT, 'src/app/apple-icon.png')).metadata();
    expect([apple.width, apple.height, apple.hasAlpha]).toEqual([180, 180, false]);
    expect(existsSync(join(ROOT, 'src/app/icon.svg'))).toBe(false);
  });
});

describe('favicon.ico', () => {
  it('is an ICO holding 16, 32 and 48 px images', () => {
    const ico = readFileSync(join(ROOT, 'src/app/favicon.ico'));
    expect(ico.readUInt16LE(2)).toBe(1); // type: icon
    const count = ico.readUInt16LE(4);
    const sizes = Array.from({ length: count }, (_, i) => ico.readUInt8(6 + i * 16));
    expect(sizes).toEqual([16, 32, 48]);
  });
});
