// 26.2 — the brand artwork, built from the operator's sources in assets/brand/ with sharp:
//
//   public/brand/icon.png (512), icon-192.png, icon-64.png   the icon, transparent
//   public/brand/logo-light.{webp,png}                       the lockup, dark text (light theme)
//   public/brand/logo-dark.{webp,png}                        the lockup, near-white text (dark theme)
//   public/brand/logo-og.png                                 the light lockup at 192 px tall (link previews)
//   src/app/icon.png (512), src/app/apple-icon.png (180, on #f5f5f5), src/app/favicon.ico (16/32/48)
//
//   node scripts/brand/build-brand-assets.mjs
//
// Background removal: the sources sit on a flat light grey. Alpha ramps with the colour distance
// from that grey (soft edges, the glow kept), and each soft pixel's colour is un-mixed from the
// grey so no light halo shows on a dark page. In the icon only the background connected to the
// image border is removed (flood fill), so the icon's own pale panel and lit film windows stay
// opaque. In the lockup's text (everything right of the icon) every light pixel goes, including
// the counters of o, P and d. The dark variant recolours only that text region to near-white.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'assets/brand');
const OUT = join(ROOT, 'public/brand');
const APP = join(ROOT, 'src/app');

/** Colour distance below which a pixel is pure background, and above which it is opaque. */
const CLEAR = 10;
const SOLID = 38;
/** The lockup is drawn 40 px tall in the headers; 2× for sharp screens. */
const LOGO_HEIGHT = 80;
/** Near-white for the dark-theme wordmark (the Darkroom ink token, oklch(0.95 0.004 250)). */
const DARK_TEXT = [238, 240, 243];
/** The apple-touch icon's background: Apple does not keep transparency. */
const APPLE_BG = '#f5f5f5';

async function load(file) {
  const { data, info } = await sharp(join(SRC, file))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** The background colour: the median of the four 8×8 corners. */
function backgroundOf({ data, width, height }) {
  const samples = [[], [], []];
  for (const [cx, cy] of [
    [0, 0],
    [width - 8, 0],
    [0, height - 8],
    [width - 8, height - 8],
  ]) {
    for (let y = cy; y < cy + 8; y++) {
      for (let x = cx; x < cx + 8; x++) {
        const i = (y * width + x) * 3;
        for (let c = 0; c < 3; c++) samples[c].push(data[i + c]);
      }
    }
  }
  return samples.map((s) => s.sort((a, b) => a - b)[s.length >> 1]);
}

function distance(data, i, bg) {
  return Math.hypot(data[i] - bg[0], data[i + 1] - bg[1], data[i + 2] - bg[2]);
}

function ramp(d) {
  if (d <= CLEAR) return 0;
  if (d >= SOLID) return 1;
  const t = (d - CLEAR) / (SOLID - CLEAR);
  return t * t * (3 - 2 * t);
}

/** Pixels within SOLID of the background that connect to the image border (4-neighbour). */
function borderBackground({ data, width, height }, bg, x0 = 0, x1 = width) {
  const seen = new Uint8Array(width * height);
  const stack = [];
  const push = (x, y) => {
    if (x < x0 || x >= x1 || y < 0 || y >= height) return;
    const p = y * width + x;
    if (seen[p] || distance(data, p * 3, bg) >= SOLID) return;
    seen[p] = 1;
    stack.push(p);
  };
  for (let x = x0; x < x1; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    push(x0, y);
    push(x1 - 1, y);
  }
  while (stack.length) {
    const p = stack.pop();
    const x = p % width;
    const y = (p - x) / width;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }
  return seen;
}

/**
 * RGBA from RGB. `region(x)` is 'icon' (flood-filled background only) or 'text' (every light
 * pixel); `textColour` replaces the text's colour (dark variant), keeping its alpha.
 */
function cutOut(img, bg, { iconEnd = img.width, textColour } = {}) {
  const { data, width, height } = img;
  const outside = borderBackground(img, bg, 0, Math.min(iconEnd, width));
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const i = p * 3;
      const inText = x >= iconEnd;
      const a = inText || outside[p] ? ramp(distance(data, i, bg)) : 1;
      const o = p * 4;
      for (let c = 0; c < 3; c++) {
        // Un-mix the background: observed = a·fg + (1−a)·bg.
        const fg = a > 0 ? (data[i + c] - (1 - a) * bg[c]) / a : 0;
        out[o + c] = inText && textColour ? textColour[c] : Math.max(0, Math.min(255, fg));
      }
      out[o + 3] = Math.round(a * 255);
    }
  }
  return out;
}

/** The first column after the icon: the start of the gap between the icon and the wordmark. */
function iconEndColumn(img, bg) {
  const { data, width, height } = img;
  const busy = (x) => {
    for (let y = 0; y < height; y++)
      if (distance(data, (y * width + x) * 3, bg) >= SOLID) return true;
    return false;
  };
  let x = 0;
  while (x < width && !busy(x)) x++;
  while (x < width && busy(x)) x++;
  // Half-way into the gap, so the icon's soft glow stays with the icon.
  let gapEnd = x;
  while (gapEnd < width && !busy(gapEnd)) gapEnd++;
  return Math.round((x + gapEnd) / 2);
}

async function trimmed(rgba, width, height, padRatio) {
  const t = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .trim({ threshold: 1 })
    .png()
    .toBuffer({ resolveWithObject: true });
  const pad = Math.round(Math.max(t.info.width, t.info.height) * padRatio);
  return sharp(t.data)
    .extend({
      top: pad,
      bottom: pad,
      left: pad,
      right: pad,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
}

async function squareIcon(png, px) {
  return sharp(png)
    .resize(px, px, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9, palette: true, quality: 90, effort: 10 })
    .toBuffer();
}

// ICO: a 6-byte header, one 16-byte entry per image, then the PNG data (PNG-in-ICO).
function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ px, data }, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(px % 256, e);
    header.writeUInt8(px % 256, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.data)]);
}

mkdirSync(OUT, { recursive: true });
const write = (path, data) => {
  writeFileSync(path, data);
  process.stdout.write(`${path.slice(ROOT.length + 1)}  ${data.length} bytes\n`);
};

// The icon.
const iconSrc = await load('icon-source.jpg');
const iconBg = backgroundOf(iconSrc);
const icon = await trimmed(cutOut(iconSrc, iconBg), iconSrc.width, iconSrc.height, 0.04);
for (const [file, px] of [
  ['icon.png', 512],
  ['icon-192.png', 192],
  ['icon-64.png', 64],
]) {
  write(join(OUT, file), await squareIcon(icon, px));
}
write(join(APP, 'icon.png'), await squareIcon(icon, 512));
const apple = await sharp(await squareIcon(icon, 144))
  .extend({ top: 18, bottom: 18, left: 18, right: 18, background: APPLE_BG })
  .flatten({ background: APPLE_BG })
  .png()
  .toBuffer();
write(join(APP, 'apple-icon.png'), apple);
const favicons = await Promise.all(
  [16, 32, 48].map(async (px) => ({ px, data: await squareIcon(icon, px) })),
);
write(join(APP, 'favicon.ico'), ico(favicons));

// The lockup, light and dark.
const logoSrc = await load('logo-source.jpg');
const logoBg = backgroundOf(logoSrc);
const iconEnd = iconEndColumn(logoSrc, logoBg);
for (const [variant, textColour] of [
  ['light', undefined],
  ['dark', DARK_TEXT],
]) {
  const rgba = cutOut(logoSrc, logoBg, { iconEnd, textColour });
  const png = await trimmed(rgba, logoSrc.width, logoSrc.height, 0.02);
  const sized = sharp(png).resize({ height: LOGO_HEIGHT });
  write(
    join(OUT, `logo-${variant}.png`),
    await sized.clone().png({ compressionLevel: 9 }).toBuffer(),
  );
  write(
    join(OUT, `logo-${variant}.webp`),
    await sized.clone().webp({ quality: 90, alphaQuality: 100 }).toBuffer(),
  );
}
const ogLockup = await trimmed(
  cutOut(logoSrc, logoBg, { iconEnd }),
  logoSrc.width,
  logoSrc.height,
  0.02,
);
write(
  join(OUT, 'logo-og.png'),
  await sharp(ogLockup)
    .resize({ height: 192 })
    .png({ compressionLevel: 9, palette: true, quality: 90 })
    .toBuffer(),
);
const meta = await sharp(readFileSync(join(OUT, 'logo-light.png'))).metadata();
process.stdout.write(`lockup ${meta.width}×${meta.height}\n`);
