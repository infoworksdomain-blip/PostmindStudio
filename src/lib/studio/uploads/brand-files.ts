// BACKLOG 15.B1 — file checks for brand-kit uploads, from the bytes (never the declared type):
//   - PNG: signature, IHDR size and colour type, and whether it carries transparency (colour
//     type 4/6 = alpha channel, or a tRNS chunk before the first IDAT). PNG spec (W3C, 3rd ed.)
//     §5.2 signature, §11.2.1 IHDR, §11.3.2 tRNS: https://www.w3.org/TR/png-3/ (read 2026-09-28).
//   - JPEG: SOFn marker frame size (ITU T.81 B.2.2) for intro/outro card stills.
//   - TrueType/OpenType: the `name` table's family name (nameID 16 typographic family, else 1),
//     which is what Shotstack matches a custom font by ("This must be the Family name embedded
//     in the font"). OpenType spec, "name — Naming Table":
//     https://learn.microsoft.com/en-us/typography/opentype/spec/name (read 2026-09-28).

export interface ImageInfo {
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  /** PNG only: an alpha channel or a tRNS chunk. JPEG is never transparent. */
  hasAlpha: boolean;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function u16(b: Uint8Array, at: number): number {
  return ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
}

function u32(b: Uint8Array, at: number): number {
  return (
    (((b[at] ?? 0) << 24) >>> 0) +
    ((b[at + 1] ?? 0) << 16) +
    ((b[at + 2] ?? 0) << 8) +
    (b[at + 3] ?? 0)
  );
}

function ascii(b: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...b.subarray(at, at + length));
}

export function parsePng(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 33 || !PNG_SIGNATURE.every((v, i) => bytes[i] === v)) return null;
  if (ascii(bytes, 12, 4) !== 'IHDR') return null;
  const width = u32(bytes, 16);
  const height = u32(bytes, 20);
  const colourType = bytes[25] ?? 0;
  let hasAlpha = colourType === 4 || colourType === 6;
  // Walk the chunks up to the first IDAT (tRNS must precede it).
  let at = 8;
  while (!hasAlpha && at + 8 <= bytes.length) {
    const length = u32(bytes, at);
    const type = ascii(bytes, at + 4, 4);
    if (type === 'tRNS') hasAlpha = true;
    if (type === 'IDAT' || type === 'IEND') break;
    at += 12 + length;
  }
  if (width === 0 || height === 0) return null;
  return { format: 'png', width, height, hasAlpha };
}

export function parseJpeg(bytes: Uint8Array): ImageInfo | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    const length = u16(bytes, at + 2);
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const height = u16(bytes, at + 5);
      const width = u16(bytes, at + 7);
      return width && height ? { format: 'jpeg', width, height, hasAlpha: false } : null;
    }
    at += 2 + length;
  }
  return null;
}

export function parseImage(bytes: Uint8Array): ImageInfo | null {
  return parsePng(bytes) ?? parseJpeg(bytes);
}

const SFNT_VERSIONS = new Set([0x00010000, 0x4f54544f /* OTTO */, 0x74727565 /* true */]);

function decodeName(bytes: Uint8Array, platformId: number): string {
  if (platformId === 0 || platformId === 3) {
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(u16(bytes, i));
    return out;
  }
  return String.fromCharCode(...bytes); // Macintosh Roman: ASCII-compatible for family names
}

/** The font's family name, or null when the file is not a TrueType/OpenType font. */
export function parseFontFamily(bytes: Uint8Array): string | null {
  if (bytes.length < 12 || !SFNT_VERSIONS.has(u32(bytes, 0))) return null;
  const numTables = u16(bytes, 4);
  let nameOffset = -1;
  let nameLength = 0;
  for (let i = 0; i < numTables; i += 1) {
    const record = 12 + i * 16;
    if (record + 16 > bytes.length) return null;
    if (ascii(bytes, record, 4) === 'name') {
      nameOffset = u32(bytes, record + 8);
      nameLength = u32(bytes, record + 12);
      break;
    }
  }
  if (nameOffset < 0 || nameOffset + 6 > bytes.length) return null;
  const table = bytes.subarray(nameOffset, Math.min(bytes.length, nameOffset + nameLength));
  const count = u16(table, 2);
  const stringStart = u16(table, 4);
  const candidates: Array<{ rank: number; value: string }> = [];
  for (let i = 0; i < count; i += 1) {
    const r = 6 + i * 12;
    if (r + 12 > table.length) break;
    const platformId = u16(table, r);
    const languageId = u16(table, r + 4);
    const nameId = u16(table, r + 6);
    if (nameId !== 1 && nameId !== 16) continue;
    const length = u16(table, r + 8);
    const offset = stringStart + u16(table, r + 10);
    if (offset + length > table.length) continue;
    const value = decodeName(table.subarray(offset, offset + length), platformId).trim();
    if (!value) continue;
    // Prefer the typographic family (16), Windows English, then anything.
    const rank =
      (nameId === 16 ? 0 : 10) +
      (platformId === 3 && languageId === 0x409 ? 0 : platformId === 3 ? 1 : 2);
    candidates.push({ rank, value });
  }
  candidates.sort((a, b) => a.rank - b.rank);
  return candidates[0]?.value ?? null;
}
