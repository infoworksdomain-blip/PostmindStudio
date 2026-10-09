// 26.2 — static Geist TTFs for the link-preview image (src/app/opengraph-image.tsx).
//
// next/og (Satori) reads TTF/OTF/WOFF only and draws a variable font's default outlines, while the
// only Geist in node_modules is @fontsource-variable/geist: variable WOFF2. This script decodes the
// Latin WOFF2 (Brotli via node:zlib, plus the WOFF2 glyf/loca transform), applies the gvar deltas for
// one weight (the advance width comes from the gvar phantom points), and writes a plain static TTF
// without hinting, variation tables or the WOFF2 wrapper. No network, no extra dependency.
//
//   node scripts/fonts/geist-og-instances.mjs
//
// Writes public/fonts/og/Geist-Regular.ttf (400) and public/fonts/og/Geist-SemiBold.ttf (600).
// Geist is © Vercel, SIL Open Font License 1.1 (public/fonts/og/OFL.txt).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(
  ROOT,
  'node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2',
);
const OUT = join(ROOT, 'public/fonts/og');

// ── WOFF2 container ────────────────────────────────────────────────────────────────────────────

const KNOWN_TAGS = [
  'cmap',
  'head',
  'hhea',
  'hmtx',
  'maxp',
  'name',
  'OS/2',
  'post',
  'cvt ',
  'fpgm',
  'glyf',
  'loca',
  'prep',
  'CFF ',
  'VORG',
  'EBDT',
  'EBLC',
  'gasp',
  'hdmx',
  'kern',
  'LTSH',
  'PCLT',
  'VDMX',
  'vhea',
  'vmtx',
  'BASE',
  'GDEF',
  'GPOS',
  'GSUB',
  'EBSC',
  'JSTF',
  'MATH',
  'CBDT',
  'CBLC',
  'COLR',
  'CPAL',
  'SVG ',
  'sbix',
  'acnt',
  'avar',
  'bdat',
  'bloc',
  'bsln',
  'cvar',
  'fdsc',
  'feat',
  'fmtx',
  'fvar',
  'gvar',
  'hsty',
  'just',
  'lcar',
  'mort',
  'morx',
  'opbd',
  'prop',
  'trak',
  'Zapf',
  'Silf',
  'Glat',
  'Gloc',
  'Feat',
  'Sill',
];

class Reader {
  constructor(buf, pos = 0) {
    this.b = buf;
    this.p = pos;
  }
  u8() {
    return this.b[this.p++];
  }
  u16() {
    const v = this.b.readUInt16BE(this.p);
    this.p += 2;
    return v;
  }
  i16() {
    const v = this.b.readInt16BE(this.p);
    this.p += 2;
    return v;
  }
  u32() {
    const v = this.b.readUInt32BE(this.p);
    this.p += 4;
    return v;
  }
  bytes(n) {
    const v = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return v;
  }
  base128() {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const c = this.u8();
      v = v * 128 + (c & 0x7f);
      if (!(c & 0x80)) return v;
    }
    throw new Error('bad UIntBase128');
  }
  u255() {
    const c = this.u8();
    if (c === 253) return this.u16();
    if (c === 255) return 253 + this.u8();
    if (c === 254) return 506 + this.u8();
    return c;
  }
}

function readWoff2(buf) {
  const r = new Reader(buf);
  if (r.u32() !== 0x774f4632) throw new Error('not WOFF2');
  r.p = 12;
  const numTables = r.u16();
  r.p = 48;
  const dir = [];
  for (let i = 0; i < numTables; i++) {
    const flags = r.u8();
    const tag = (flags & 63) === 63 ? r.bytes(4).toString('latin1') : KNOWN_TAGS[flags & 63];
    const version = (flags >> 6) & 3;
    const origLength = r.base128();
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    const length = transformed ? r.base128() : origLength;
    dir.push({ tag, length, transformed });
  }
  const data = brotliDecompressSync(buf.subarray(r.p));
  const tables = {};
  let off = 0;
  for (const t of dir) {
    tables[t.tag] = { data: data.subarray(off, off + t.length), transformed: t.transformed };
    off += t.length;
  }
  return tables;
}

// ── glyf transform → glyph objects ─────────────────────────────────────────────────────────────

function withSign(flag, base) {
  return flag & 1 ? base : -base;
}

function decodeGlyf(buf) {
  const h = new Reader(buf);
  h.u16();
  const optionFlags = h.u16();
  const numGlyphs = h.u16();
  h.u16();
  const sizes = Array.from({ length: 7 }, () => h.u32());
  let off = h.p;
  const stream = sizes.map((s) => {
    const rd = new Reader(buf.subarray(off, off + s));
    off += s;
    return rd;
  });
  const [nContour, nPoints, flagS, glyphS, compS, bboxS, instrS] = stream;
  if (optionFlags & 1) throw new Error('overlap bitmap not supported');
  const bitmapLen = 4 * Math.floor((numGlyphs + 31) / 32);
  const bboxBitmap = bboxS.bytes(bitmapLen);
  const hasBbox = (g) => (bboxBitmap[g >> 3] >> (7 - (g & 7))) & 1;

  const glyphs = [];
  for (let g = 0; g < numGlyphs; g++) {
    const n = nContour.i16();
    if (n === 0) {
      glyphs.push({ kind: 'empty' });
      continue;
    }
    if (n < 0) {
      const components = [];
      let more = true;
      let hasInstr = false;
      while (more) {
        const flags = compS.u16();
        const glyphIndex = compS.u16();
        const words = flags & 0x0001;
        const a1 = words ? compS.i16() : flags & 0x0002 ? compS.b.readInt8(compS.p++) : compS.u8();
        const a2 = words ? compS.i16() : flags & 0x0002 ? compS.b.readInt8(compS.p++) : compS.u8();
        let scale = Buffer.alloc(0);
        if (flags & 0x0008) scale = compS.bytes(2);
        else if (flags & 0x0040) scale = compS.bytes(4);
        else if (flags & 0x0080) scale = compS.bytes(8);
        components.push({ flags, glyphIndex, a1, a2, scale });
        if (flags & 0x0100) hasInstr = true;
        more = Boolean(flags & 0x0020);
      }
      if (hasInstr) instrS.bytes(glyphS.u255());
      const bbox = [bboxS.i16(), bboxS.i16(), bboxS.i16(), bboxS.i16()];
      glyphs.push({ kind: 'composite', components, bbox });
      continue;
    }
    const endPts = [];
    let total = 0;
    for (let c = 0; c < n; c++) {
      total += nPoints.u255();
      endPts.push(total - 1);
    }
    const xs = [];
    const ys = [];
    const on = [];
    let x = 0;
    let y = 0;
    for (let i = 0; i < total; i++) {
      const raw = flagS.u8();
      on.push(!(raw & 0x80));
      const f = raw & 0x7f;
      let dx;
      let dy;
      if (f < 10) {
        dx = 0;
        dy = withSign(f, ((f & 14) << 7) + glyphS.u8());
      } else if (f < 20) {
        dx = withSign(f, (((f - 10) & 14) << 7) + glyphS.u8());
        dy = 0;
      } else if (f < 84) {
        const b0 = f - 20;
        const b1 = glyphS.u8();
        dx = withSign(f, 1 + (b0 & 0x30) + (b1 >> 4));
        dy = withSign(f >> 1, 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f));
      } else if (f < 120) {
        const b0 = f - 84;
        dx = withSign(f, 1 + (Math.floor(b0 / 12) << 8) + glyphS.u8());
        dy = withSign(f >> 1, 1 + (((b0 % 12) >> 2) << 8) + glyphS.u8());
      } else if (f < 124) {
        const b1 = glyphS.u8();
        const b2 = glyphS.u8();
        const b3 = glyphS.u8();
        dx = withSign(f, (b1 << 4) + (b2 >> 4));
        dy = withSign(f >> 1, ((b2 & 0x0f) << 8) + b3);
      } else {
        const b1 = glyphS.u8();
        const b2 = glyphS.u8();
        const b3 = glyphS.u8();
        const b4 = glyphS.u8();
        dx = withSign(f, (b1 << 8) + b2);
        dy = withSign(f >> 1, (b3 << 8) + b4);
      }
      x += dx;
      y += dy;
      xs.push(x);
      ys.push(y);
    }
    instrS.bytes(glyphS.u255());
    if (hasBbox(g)) bboxS.bytes(8);
    glyphs.push({ kind: 'simple', endPts, xs, ys, on });
  }
  return glyphs;
}

// ── gvar instancing ────────────────────────────────────────────────────────────────────────────

function readPackedPoints(r) {
  let count = r.u8();
  if (count === 0) return null; // all points
  if (count & 0x80) count = ((count & 0x7f) << 8) | r.u8();
  const pts = [];
  let last = 0;
  while (pts.length < count) {
    const c = r.u8();
    const run = (c & 0x7f) + 1;
    for (let i = 0; i < run && pts.length < count; i++) {
      last += c & 0x80 ? r.u16() : r.u8();
      pts.push(last);
    }
  }
  return pts;
}

function readPackedDeltas(r, count) {
  const out = [];
  while (out.length < count) {
    const c = r.u8();
    const run = (c & 0x3f) + 1;
    for (let i = 0; i < run; i++) {
      if (c & 0x80) out.push(0);
      else if (c & 0x40) out.push(r.i16());
      else out.push(r.b.readInt8(r.p++));
    }
  }
  return out;
}

function tupleScalar(coord, peak, start, end) {
  if (peak === 0) return 1;
  if (coord === 0 || Math.sign(coord) !== Math.sign(peak)) return 0;
  if (start === undefined) {
    if (Math.abs(coord) > Math.abs(peak)) return 1;
    return coord / peak;
  }
  if (coord < start || coord > end) return 0;
  if (coord === peak) return 1;
  return coord < peak ? (coord - start) / (peak - start) : (end - coord) / (end - peak);
}

// Interpolate untouched points from touched neighbours within one contour (gvar "IUP").
function iup(orig, delta, touched, start, end) {
  const idx = [];
  for (let i = start; i <= end; i++) if (touched[i]) idx.push(i);
  if (idx.length === 0) return;
  const n = end - start + 1;
  for (let k = 0; k < idx.length; k++) {
    const a = idx[k];
    const b = idx[(k + 1) % idx.length];
    let i = a + 1;
    const steps = (b - a - 1 + n) % n;
    for (let s = 0; s < steps; s++, i++) {
      const p = start + ((i - start) % n);
      const oa = orig[a];
      const ob = orig[b];
      const lo = Math.min(oa, ob);
      const hi = Math.max(oa, ob);
      const da = oa <= ob ? delta[a] : delta[b];
      const db = oa <= ob ? delta[b] : delta[a];
      const o = orig[p];
      if (o <= lo) delta[p] = da;
      else if (o >= hi) delta[p] = db;
      else if (lo === hi) delta[p] = da === db ? da : 0;
      else delta[p] = da + ((o - lo) / (hi - lo)) * (db - da);
    }
  }
}

function instance(tables, glyphs, wght) {
  const fvar = new Reader(tables.fvar.data);
  fvar.p = 4;
  const axesOffset = fvar.u16();
  fvar.p = axesOffset + 4;
  const min = fvar.u32() / 65536;
  const def = fvar.u32() / 65536;
  const max = fvar.u32() / 65536;
  const coord =
    wght === def ? 0 : wght > def ? (wght - def) / (max - def) : (wght - def) / (def - min);

  const hmtx = new Reader(tables.hmtx.data);
  const hhea = tables.hhea.data;
  const numH = hhea.readUInt16BE(34);
  const advances = glyphs.map((_, g) => {
    hmtx.p = Math.min(g, numH - 1) * 4;
    return hmtx.u16();
  });

  const gv = new Reader(tables.gvar.data);
  gv.p = 4;
  const axisCount = gv.u16();
  const sharedCount = gv.u16();
  const sharedOff = gv.u32();
  const glyphCount = gv.u16();
  const flags = gv.u16();
  const dataOff = gv.u32();
  const offsets = Array.from({ length: glyphCount + 1 }, () =>
    flags & 1 ? gv.u32() : gv.u16() * 2,
  );
  if (axisCount !== 1) throw new Error('expected one axis');
  const shared = [];
  gv.p = sharedOff;
  for (let i = 0; i < sharedCount; i++) shared.push(gv.i16() / 16384);

  return glyphs.map((glyph, g) => {
    const start = dataOff + offsets[g];
    const endOff = dataOff + offsets[g + 1];
    const advance = advances[g];
    if (glyph.kind === 'empty' || start === endOff || coord === 0) return { glyph, advance };
    const isSimple = glyph.kind === 'simple';
    const nPts = (isSimple ? glyph.xs.length : glyph.components.length) + 4;
    const ox = isSimple ? [...glyph.xs] : glyph.components.map((c) => c.a1);
    const oy = isSimple ? [...glyph.ys] : glyph.components.map((c) => c.a2);
    ox.push(0, advance, 0, 0);
    oy.push(0, 0, 0, 0);
    const dx = new Array(nPts).fill(0);
    const dy = new Array(nPts).fill(0);

    const h = new Reader(tables.gvar.data, start);
    const countWord = h.u16();
    const count = countWord & 0x0fff;
    const ser = new Reader(tables.gvar.data, start + h.u16());
    const sharedPoints = countWord & 0x8000 ? readPackedPoints(ser) : undefined;
    for (let t = 0; t < count; t++) {
      const size = h.u16();
      const tupleIndex = h.u16();
      const peak = tupleIndex & 0x8000 ? h.i16() / 16384 : shared[tupleIndex & 0x0fff];
      let s;
      let e;
      if (tupleIndex & 0x4000) {
        s = h.i16() / 16384;
        e = h.i16() / 16384;
      }
      const tupleStart = ser.p;
      const points = tupleIndex & 0x2000 ? readPackedPoints(ser) : sharedPoints;
      const scalar = tupleScalar(coord, peak, s, e);
      const list = points ?? Array.from({ length: nPts }, (_, i) => i);
      const xd = readPackedDeltas(ser, list.length);
      const yd = readPackedDeltas(ser, list.length);
      ser.p = tupleStart + size;
      if (scalar === 0) continue;
      const tx = new Array(nPts).fill(0);
      const ty = new Array(nPts).fill(0);
      const touched = new Array(nPts).fill(false);
      list.forEach((p, i) => {
        if (p >= nPts) return;
        tx[p] = xd[i];
        ty[p] = yd[i];
        touched[p] = true;
      });
      if (points && isSimple) {
        let c0 = 0;
        for (const c1 of glyph.endPts) {
          iup(ox, tx, touched, c0, c1);
          iup(oy, ty, touched, c0, c1);
          c0 = c1 + 1;
        }
      }
      for (let i = 0; i < nPts; i++) {
        dx[i] += tx[i] * scalar;
        dy[i] += ty[i] * scalar;
      }
    }
    const n = nPts - 4;
    const nx = ox.map((v, i) => Math.round(v + dx[i]));
    const ny = oy.map((v, i) => Math.round(v + dy[i]));
    const newAdvance = Math.round(advance + dx[n + 1] - dx[n]);
    if (isSimple) {
      return { glyph: { ...glyph, xs: nx.slice(0, n), ys: ny.slice(0, n) }, advance: newAdvance };
    }
    const components = glyph.components.map((c, i) =>
      c.flags & 0x0002 ? { ...c, a1: nx[i], a2: ny[i] } : c,
    );
    return { glyph: { ...glyph, components }, advance: newAdvance };
  });
}

// ── static TTF writer ──────────────────────────────────────────────────────────────────────────

function encodeGlyph(glyph, bboxOf) {
  if (glyph.kind === 'empty') return { bytes: Buffer.alloc(0), xMin: 0 };
  if (glyph.kind === 'simple') {
    const xMin = Math.min(...glyph.xs);
    const head = Buffer.alloc(10 + glyph.endPts.length * 2 + 2);
    head.writeInt16BE(glyph.endPts.length, 0);
    head.writeInt16BE(xMin, 2);
    head.writeInt16BE(Math.min(...glyph.ys), 4);
    head.writeInt16BE(Math.max(...glyph.xs), 6);
    head.writeInt16BE(Math.max(...glyph.ys), 8);
    glyph.endPts.forEach((e, i) => head.writeUInt16BE(e, 10 + i * 2));
    head.writeUInt16BE(0, 10 + glyph.endPts.length * 2); // no instructions
    const n = glyph.xs.length;
    const flags = Buffer.from(glyph.on.map((o) => (o ? 1 : 0)));
    const coords = Buffer.alloc(n * 4);
    let px = 0;
    let py = 0;
    for (let i = 0; i < n; i++) {
      coords.writeInt16BE(glyph.xs[i] - px, i * 2);
      coords.writeInt16BE(glyph.ys[i] - py, n * 2 + i * 2);
      px = glyph.xs[i];
      py = glyph.ys[i];
    }
    return { bytes: Buffer.concat([head, flags, coords]), xMin };
  }
  const [xMin, yMin, xMax, yMax] = bboxOf(glyph);
  const parts = [Buffer.alloc(10)];
  parts[0].writeInt16BE(-1, 0);
  parts[0].writeInt16BE(xMin, 2);
  parts[0].writeInt16BE(yMin, 4);
  parts[0].writeInt16BE(xMax, 6);
  parts[0].writeInt16BE(yMax, 8);
  for (const c of glyph.components) {
    const b = Buffer.alloc(8);
    b.writeUInt16BE((c.flags | 0x0001) & ~0x0100, 0);
    b.writeUInt16BE(c.glyphIndex, 2);
    if (c.flags & 0x0002) {
      b.writeInt16BE(c.a1, 4);
      b.writeInt16BE(c.a2, 6);
    } else {
      b.writeUInt16BE(c.a1, 4);
      b.writeUInt16BE(c.a2, 6);
    }
    parts.push(b, c.scale);
  }
  return { bytes: Buffer.concat(parts), xMin };
}

function pad4(b) {
  return b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b;
}

function checksum(b) {
  const p = pad4(b);
  let sum = 0;
  for (let i = 0; i < p.length; i += 4) sum = (sum + p.readUInt32BE(i)) >>> 0;
  return sum;
}

function writeTtf(tables, instanced) {
  const glyphs = instanced.map((i) => i.glyph);
  // Composite bounding boxes: the union of their (already instanced) simple components.
  const bboxOf = (glyph) => {
    let box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const c of glyph.components) {
      const child = glyphs[c.glyphIndex];
      const cb =
        child.kind === 'simple'
          ? [
              Math.min(...child.xs),
              Math.min(...child.ys),
              Math.max(...child.xs),
              Math.max(...child.ys),
            ]
          : child.kind === 'composite'
            ? bboxOf(child)
            : null;
      if (!cb) continue;
      const ox = c.flags & 0x0002 ? c.a1 : 0;
      const oy = c.flags & 0x0002 ? c.a2 : 0;
      box = [
        Math.min(box[0], cb[0] + ox),
        Math.min(box[1], cb[1] + oy),
        Math.max(box[2], cb[2] + ox),
        Math.max(box[3], cb[3] + oy),
      ];
    }
    return box[0] === Infinity ? glyph.bbox : box;
  };
  const encoded = glyphs.map((g) => encodeGlyph(g, bboxOf));
  const glyf = [];
  const loca = Buffer.alloc((glyphs.length + 1) * 4);
  let off = 0;
  encoded.forEach((e, i) => {
    loca.writeUInt32BE(off, i * 4);
    const p = pad4(e.bytes);
    glyf.push(p);
    off += p.length;
  });
  loca.writeUInt32BE(off, glyphs.length * 4);

  const hmtx = Buffer.alloc(glyphs.length * 4);
  instanced.forEach((g, i) => {
    hmtx.writeUInt16BE(g.advance, i * 4);
    hmtx.writeInt16BE(encoded[i].xMin, i * 4 + 2);
  });
  const hhea = Buffer.from(tables.hhea.data);
  hhea.writeUInt16BE(glyphs.length, 34);
  hhea.writeUInt16BE(Math.max(...instanced.map((g) => g.advance)), 10);
  const head = Buffer.from(tables.head.data);
  head.writeUInt32BE(0, 8); // checksumAdjustment, set below
  head.writeInt16BE(1, 50); // long loca

  const out = {
    cmap: tables.cmap.data,
    head,
    hhea,
    hmtx,
    maxp: tables.maxp.data,
    name: tables.name.data,
    'OS/2': tables['OS/2'].data,
    post: tables.post.data,
    glyf: Buffer.concat(glyf),
    loca,
    GDEF: tables.GDEF.data,
    GPOS: tables.GPOS.data,
    GSUB: tables.GSUB.data,
  };
  const tags = Object.keys(out).sort();
  const n = tags.length;
  const pow = 2 ** Math.floor(Math.log2(n));
  const header = Buffer.alloc(12 + n * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(n, 4);
  header.writeUInt16BE(pow * 16, 6);
  header.writeUInt16BE(Math.log2(pow), 8);
  header.writeUInt16BE(n * 16 - pow * 16, 10);
  let dataOff = header.length;
  const bodies = [];
  tags.forEach((tag, i) => {
    const body = out[tag];
    header.write(tag, 12 + i * 16, 'latin1');
    header.writeUInt32BE(checksum(body), 16 + i * 16);
    header.writeUInt32BE(dataOff, 20 + i * 16);
    header.writeUInt32BE(body.length, 24 + i * 16);
    const p = pad4(body);
    bodies.push(p);
    dataOff += p.length;
  });
  const font = Buffer.concat([header, ...bodies]);
  const headOffset = header.readUInt32BE(20 + tags.indexOf('head') * 16);
  font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headOffset + 8);
  return font;
}

const tables = readWoff2(readFileSync(SRC));
const glyphs = decodeGlyf(tables.glyf.data);
mkdirSync(OUT, { recursive: true });
for (const [weight, file] of [
  [400, 'Geist-Regular.ttf'],
  [600, 'Geist-SemiBold.ttf'],
]) {
  const ttf = writeTtf(tables, instance(tables, glyphs, weight));
  writeFileSync(join(OUT, file), ttf);
  process.stdout.write(`${file}: ${ttf.length} bytes (wght ${weight})\n`);
}
