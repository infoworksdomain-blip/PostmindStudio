import { deflateRawSync } from 'node:zlib';

// Minimal ZIP writer for the 15.E1 data export (PKWARE APPNOTE 6.3.10, sections 4.3.7 local file
// header, 4.3.12 central directory header, 4.3.16 end of central directory record;
// https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT). Entries are DEFLATE-compressed
// (method 8) with UTF-8 names (general purpose bit 11). No ZIP64: an export over 4 GiB or 65,535
// entries is refused, which the per-table row caps keep far away from.

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const MAX_U32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;
const UTF8_FLAG = 0x0800;
const DEFLATE = 8;
// 1980-01-01 00:00 in MS-DOS format (time 0, date (0 << 9) | (1 << 5) | 1).
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

let crcTable: Uint32Array | undefined;

export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1)
    crc = (crcTable[(crc ^ (data[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function createZip(entries: ZipEntry[]): Uint8Array {
  if (entries.length > MAX_ENTRIES) throw new RangeError('Too many ZIP entries (no ZIP64)');
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    if (entry.data.length > MAX_U32 || offset > MAX_U32)
      throw new RangeError('ZIP entry too large (no ZIP64)');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(DEFLATE, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  if (offset > MAX_U32 || centralSize > MAX_U32) throw new RangeError('ZIP too large (no ZIP64)');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, ...centrals, end]));
}
