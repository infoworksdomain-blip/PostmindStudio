// Minimal PNG bytes (signature + IHDR) with the requested dimensions. Enough for image-size,
// which reads dimensions from the header only. Not a decodable image.

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function fakePng(width: number, height: number, salt = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(8 + 25 + 4);
  bytes.set(SIGNATURE, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24); // bit depth, colour type, compression, filter, interlace
  view.setUint32(29, salt); // CRC slot: varied so different "images" hash differently
  view.setUint32(33, 0);
  return bytes;
}

/** Deterministic bag-of-words embedding (1536 dims) so similarity search is testable. */
export function fakeEmbedding(text: string, dims = 1536): number[] {
  const vector = new Array<number>(dims).fill(0);
  for (const word of text.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
    let h = 0;
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    vector[h % dims] = (vector[h % dims] ?? 0) + 1;
  }
  vector[dims - 1] = (vector[dims - 1] ?? 0) + 0.01; // never the zero vector
  return vector;
}
