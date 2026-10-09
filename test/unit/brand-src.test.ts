import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAND_SRC } from '@/components/marketing/brand-src';

// 26.2 — the brand files the app references exist in public/brand, and the single-file demo's
// shim (demo/shims/brand-src.ts) inlines a file for each one.

const ROOT = join(__dirname, '..', '..');
const SHIM = readFileSync(join(ROOT, 'demo', 'shims', 'brand-src.ts'), 'utf8');
const urls = [
  BRAND_SRC.logoLight.webp,
  BRAND_SRC.logoLight.png,
  BRAND_SRC.logoDark.webp,
  BRAND_SRC.logoDark.png,
  BRAND_SRC.icon,
];

describe('brand artwork sources', () => {
  it('points at files that exist under public/', () => {
    for (const url of urls) expect(existsSync(join(ROOT, 'public', url)), url).toBe(true);
  });

  it('has a demo shim with the same shape that imports the artwork', () => {
    expect(SHIM).toMatch(/export const BRAND_SRC = \{/);
    for (const name of ['logoLight', 'logoDark', 'icon']) expect(SHIM).toContain(`${name}:`);
    for (const file of ['logo-light.webp', 'logo-dark.webp', 'icon-64.png'])
      expect(SHIM).toContain(`public/brand/${file}`);
  });
});
