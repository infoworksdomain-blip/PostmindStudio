// Advance-width metrics read straight from a TrueType file (21.6 carousels).
//
// Carousel slides are laid out by Studio itself (line breaks, slide splits, overflow checks), so
// the layout needs the real width of each character in the font the renderer uses. This reads the
// three tables that hold that, from the OpenType specification (read 2026-10-04):
//   - head  (unitsPerEm)               https://learn.microsoft.com/en-us/typography/opentype/spec/head
//   - hhea  (numberOfHMetrics)         https://learn.microsoft.com/en-us/typography/opentype/spec/hhea
//   - hmtx  (advanceWidth per glyph)   https://learn.microsoft.com/en-us/typography/opentype/spec/hmtx
//   - cmap  (format 4 BMP, format 12 full Unicode)
//                                      https://learn.microsoft.com/en-us/typography/opentype/spec/cmap
// Kerning and shaping (GPOS/GSUB) are ignored: kerning only ever narrows Latin text, so the widths
// are a slight over-estimate, which is the safe direction for "does it fit". Variable fonts report
// their default instance (Regular); bold text is widened by BOLD_WIDTH_FACTOR.

export interface FontMetrics {
  readonly unitsPerEm: number;
  /** Advance width in font units, or undefined when the font has no glyph for the code point. */
  advance(codePoint: number): number | undefined;
  has(codePoint: number): boolean;
}

interface TableRecord {
  readonly offset: number;
  readonly length: number;
}

function readTables(view: DataView): Map<string, TableRecord> {
  const numTables = view.getUint16(4);
  const tables = new Map<string, TableRecord>();
  for (let i = 0; i < numTables; i += 1) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(
      view.getUint8(rec),
      view.getUint8(rec + 1),
      view.getUint8(rec + 2),
      view.getUint8(rec + 3),
    );
    tables.set(tag, { offset: view.getUint32(rec + 8), length: view.getUint32(rec + 12) });
  }
  return tables;
}

function requireTable(tables: Map<string, TableRecord>, tag: string): TableRecord {
  const table = tables.get(tag);
  if (!table) throw new RangeError(`font has no ${tag} table`);
  return table;
}

/** code point → glyph id, from the best Unicode subtable (format 12 preferred, else 4). */
function readCmap(view: DataView, cmap: TableRecord): Map<number, number> {
  const numSubtables = view.getUint16(cmap.offset + 2);
  let format4: number | undefined;
  let format12: number | undefined;
  for (let i = 0; i < numSubtables; i += 1) {
    const rec = cmap.offset + 4 + i * 8;
    const platformId = view.getUint16(rec);
    const encodingId = view.getUint16(rec + 2);
    const sub = cmap.offset + view.getUint32(rec + 4);
    const format = view.getUint16(sub);
    const unicode =
      platformId === 0 || (platformId === 3 && (encodingId === 1 || encodingId === 10));
    if (!unicode) continue;
    if (format === 12 && format12 === undefined) format12 = sub;
    if (format === 4 && format4 === undefined) format4 = sub;
  }
  const map = new Map<number, number>();
  if (format12 !== undefined) {
    const groups = view.getUint32(format12 + 12);
    for (let g = 0; g < groups; g += 1) {
      const rec = format12 + 16 + g * 12;
      const start = view.getUint32(rec);
      const end = view.getUint32(rec + 4);
      const glyph = view.getUint32(rec + 8);
      for (let cp = start; cp <= end; cp += 1) map.set(cp, glyph + (cp - start));
    }
    return map;
  }
  if (format4 === undefined) throw new RangeError('font has no Unicode cmap subtable');
  const segX2 = view.getUint16(format4 + 6);
  const ends = format4 + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const rangeOffsets = deltas + segX2;
  for (let s = 0; s < segX2 / 2; s += 1) {
    const end = view.getUint16(ends + s * 2);
    const start = view.getUint16(starts + s * 2);
    const delta = view.getInt16(deltas + s * 2);
    const rangeOffsetPos = rangeOffsets + s * 2;
    const rangeOffset = view.getUint16(rangeOffsetPos);
    for (let cp = start; cp <= end && cp !== 0xffff; cp += 1) {
      let glyph: number;
      if (rangeOffset === 0) {
        glyph = (cp + delta) & 0xffff;
      } else {
        const glyphPos = rangeOffsetPos + rangeOffset + (cp - start) * 2;
        const raw = view.getUint16(glyphPos);
        glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
      }
      if (glyph !== 0) map.set(cp, glyph);
    }
  }
  return map;
}

/** Parse a TrueType/OpenType (glyf or CFF) font buffer into advance-width metrics. */
export function parseFontMetrics(buffer: Uint8Array): FontMetrics {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const tables = readTables(view);
  const head = requireTable(tables, 'head');
  const hhea = requireTable(tables, 'hhea');
  const hmtx = requireTable(tables, 'hmtx');
  const unitsPerEm = view.getUint16(head.offset + 18);
  const numberOfHMetrics = view.getUint16(hhea.offset + 34);
  const cmap = readCmap(view, requireTable(tables, 'cmap'));
  const lastAdvance = view.getUint16(hmtx.offset + (numberOfHMetrics - 1) * 4);
  const advanceOfGlyph = (glyph: number): number =>
    glyph < numberOfHMetrics ? view.getUint16(hmtx.offset + glyph * 4) : lastAdvance;
  return {
    unitsPerEm,
    advance(codePoint: number): number | undefined {
      const glyph = cmap.get(codePoint);
      return glyph === undefined ? undefined : advanceOfGlyph(glyph);
    },
    has(codePoint: number): boolean {
      return cmap.has(codePoint);
    },
  };
}
