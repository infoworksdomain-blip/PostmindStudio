import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sceneImage } from '../../demo/media';

// BACKLOG 20.8 — the demo's sample media: the brand-kit logo is an original SVG, the build inlines
// the marketing photos (the demo page cannot load files from its host), and the photographic
// scenes are drawn from those photos.

const ROOT = join(__dirname, '..', '..');

describe('demo sample media', () => {
  it('draws the sample business logo as an SVG with its name', () => {
    const url = sceneImage('logo', 400, 400);
    expect(url.startsWith('data:image/svg+xml')).toBe(true);
    const svg = decodeURIComponent(url.split(',')[1]!);
    expect(svg).toContain('Leeds Sourdough');
    expect(svg).toContain('width="400"');
  });

  it('bundles the marketing images as data: URLs through the demo shim', () => {
    const build = readFileSync(join(ROOT, 'scripts', 'demo', 'build.mjs'), 'utf8');
    expect(build).toContain("'.webp': 'dataurl'");
    expect(build).toContain('marketing-media-src.ts');
    const media = readFileSync(join(ROOT, 'demo', 'media.ts'), 'utf8');
    for (const photo of ['sourdoughLoaf', 'croissants', 'marketStall', 'coffee'])
      expect(media).toContain(`'${photo}'`);
  });
});
