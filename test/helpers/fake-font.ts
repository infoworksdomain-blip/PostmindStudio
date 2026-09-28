// 15.B1 test double: a minimal TrueType file whose `name` table holds a family name.

/** A minimal sfnt with only a `name` table holding the given family (nameID 1, Windows UTF-16). */
export function fakeTtf(family: string, nameId = 1): Uint8Array {
  const utf16 = Buffer.alloc(family.length * 2);
  for (let i = 0; i < family.length; i += 1) utf16.writeUInt16BE(family.charCodeAt(i), i * 2);
  const nameTable = Buffer.alloc(6 + 12 + utf16.length);
  nameTable.writeUInt16BE(0, 0); // format
  nameTable.writeUInt16BE(1, 2); // count
  nameTable.writeUInt16BE(18, 4); // string offset
  nameTable.writeUInt16BE(3, 6); // platform Windows
  nameTable.writeUInt16BE(1, 8); // encoding
  nameTable.writeUInt16BE(0x409, 10); // en-US
  nameTable.writeUInt16BE(nameId, 12);
  nameTable.writeUInt16BE(utf16.length, 14);
  nameTable.writeUInt16BE(0, 16);
  utf16.copy(nameTable, 18);
  const header = Buffer.alloc(12 + 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(1, 4);
  header.write('name', 12, 'ascii');
  header.writeUInt32BE(0, 16);
  header.writeUInt32BE(28, 20);
  header.writeUInt32BE(nameTable.length, 24);
  return new Uint8Array(Buffer.concat([header, nameTable]));
}
