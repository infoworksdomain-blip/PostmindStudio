// Minimal TrueType/OpenType reader for tests (BACKLOG 20.7): the family name, weight class and
// variation-axis defaults of a font file. Table layouts: OpenType spec, "name", "OS/2" and "fvar"
// (https://learn.microsoft.com/en-us/typography/opentype/spec/, read 2026-09-30).

export interface FontFacts {
  /** 0x00010000 (TrueType outlines) or "OTTO" (CFF). */
  sfntVersion: number;
  /** nameID 1 (Windows, Unicode BMP, en-US). */
  family: string | undefined;
  /** nameID 16 (typographic family), when present. */
  typographicFamily: string | undefined;
  /** OS/2 usWeightClass. */
  weightClass: number;
  /** Variation axes with their default value; empty for a static font. */
  axes: Array<{ tag: string; min: number; default: number; max: number }>;
}

function tables(buf: Buffer): Map<string, number> {
  const count = buf.readUInt16BE(4);
  const out = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const rec = 12 + 16 * i;
    out.set(buf.toString('latin1', rec, rec + 4), buf.readUInt32BE(rec + 8));
  }
  return out;
}

function windowsName(buf: Buffer, offset: number, nameId: number): string | undefined {
  const count = buf.readUInt16BE(offset + 2);
  const strings = offset + buf.readUInt16BE(offset + 4);
  for (let i = 0; i < count; i++) {
    const rec = offset + 6 + 12 * i;
    const [platform, encoding, language, id] = [0, 2, 4, 6].map((d) => buf.readUInt16BE(rec + d));
    if (platform !== 3 || encoding !== 1 || language !== 0x409 || id !== nameId) continue;
    const start = strings + buf.readUInt16BE(rec + 10);
    const bytes = buf.subarray(start, start + buf.readUInt16BE(rec + 8));
    let text = '';
    for (let j = 0; j + 1 < bytes.length; j += 2)
      text += String.fromCharCode(bytes.readUInt16BE(j));
    return text;
  }
  return undefined;
}

const fixed = (buf: Buffer, at: number) => buf.readInt32BE(at) / 65536;

export function readFontFacts(buf: Buffer): FontFacts {
  const t = tables(buf);
  const name = t.get('name');
  const os2 = t.get('OS/2');
  if (name === undefined || os2 === undefined) throw new Error('not a font: no name/OS/2 table');
  const axes: FontFacts['axes'] = [];
  const fvar = t.get('fvar');
  if (fvar !== undefined) {
    const first = fvar + buf.readUInt16BE(fvar + 4);
    const size = buf.readUInt16BE(fvar + 10);
    for (let i = 0; i < buf.readUInt16BE(fvar + 8); i++) {
      const a = first + i * size;
      axes.push({
        tag: buf.toString('latin1', a, a + 4),
        min: fixed(buf, a + 4),
        default: fixed(buf, a + 8),
        max: fixed(buf, a + 12),
      });
    }
  }
  return {
    sfntVersion: buf.readUInt32BE(0),
    family: windowsName(buf, name, 1),
    typographicFamily: windowsName(buf, name, 16),
    weightClass: buf.readUInt16BE(os2 + 4),
    axes,
  };
}
