// 25.5 — copies the landing page's Studio-made clips into public/marketing/studio/ and encodes
// their poster frames for the web (sharp, already a dependency):
//
//   <id>-720.webp  720×1280  the poster on wide screens (hero phone, video section)
//   <id>-360.webp  360×640   the poster on phones and in the format strip
//   <id>.jpg       540×960   the <picture> fallback for browsers without WebP
//   <id>.mp4                 the muted loop, copied as rendered (H.264; no re-encode here)
//
//   node scripts/marketing/encode-studio-media.mjs <homepage-media-dir>
//
// <homepage-media-dir> is the folder the operator exported from production on 2026-10-07:
// hero/seedance-*.{mp4,webp} and <business>-<format>/{loop.mp4,poster.jpg}. Afterwards update the
// byte counts in public/marketing/SOURCES.md (test/unit/marketing-media.test.ts checks sizes).

import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'public', 'marketing', 'studio');
const src = process.argv[2];
if (!src) {
  process.stderr.write(
    'usage: node scripts/marketing/encode-studio-media.mjs <homepage-media-dir>\n',
  );
  process.exit(1);
}

/** id → [video, poster source] relative to the media folder. */
const CLIPS = {
  'seedance-bread': ['hero/seedance-bread.mp4', 'hero/seedance-bread.webp'],
  'seedance-market': ['hero/seedance-market.mp4', 'hero/seedance-market.webp'],
  ...Object.fromEntries(
    [
      'northside-bakery-slideshow',
      'atelier-wren-slideshow',
      'pulse-studio-slideshow',
      'coastline-stays-slideshow',
      'greenleaf-florist-slideshow',
      'harbour-coffee-slideshow',
      'pulse-studio-wall-of-text',
      'coastline-stays-wall-of-text',
    ].map((id) => [id, [`${id}/loop.mp4`, `${id}/poster.jpg`]]),
  ),
};

mkdirSync(out, { recursive: true });
const rows = [];
for (const [id, [video, poster]] of Object.entries(CLIPS)) {
  const input = join(src, poster);
  const files = {
    [`${id}-720.webp`]: sharp(input).resize(720, 1280).webp({ quality: 60, effort: 6 }),
    [`${id}-360.webp`]: sharp(input).resize(360, 640).webp({ quality: 64, effort: 6 }),
    [`${id}.jpg`]: sharp(input).resize(540, 960).jpeg({ quality: 70, mozjpeg: true }),
  };
  for (const [name, pipeline] of Object.entries(files)) {
    await pipeline.toFile(join(out, name));
    rows.push([name, statSync(join(out, name)).size]);
  }
  copyFileSync(join(src, video), join(out, `${id}.mp4`));
  rows.push([`${id}.mp4`, statSync(join(out, `${id}.mp4`)).size]);
}
for (const [name, bytes] of rows) process.stdout.write(`studio/${name}\t${bytes}\n`);
