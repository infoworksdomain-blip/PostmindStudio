import sharp from 'sharp';

// BACKLOG 13.12 — perceptual de-duplication (spec 5.4 "perceptual hash for images").
// dHash ("difference hash"): decode, convert to greyscale, resize to 9×8, then set one bit per
// pixel pair for "left brighter than right" — 8 rows × 8 comparisons = 64 bits, written as 16
// hex characters. Resizing and re-encoding barely move the hash, so a Hamming distance of at most
// NEAR_DUPLICATE_MAX_DISTANCE between two hashes means "the same picture".

export const NEAR_DUPLICATE_MAX_DISTANCE = 6;
const HASH_WIDTH = 9;
const HASH_HEIGHT = 8;
const PHASH = /^[0-9a-f]{16}$/;

/** 64-bit dHash of an image, as 16 lower-case hex characters. Throws if it cannot be decoded. */
export async function dHash(bytes: Uint8Array): Promise<string> {
  const pixels = await sharp(bytes, { failOn: 'error', limitInputPixels: 100_000_000 })
    .rotate() // honour EXIF orientation so a rotated copy hashes like the original
    .greyscale()
    .resize(HASH_WIDTH, HASH_HEIGHT, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer();
  let bits = 0n;
  for (let y = 0; y < HASH_HEIGHT; y += 1) {
    for (let x = 0; x < HASH_WIDTH - 1; x += 1) {
      const left = pixels[y * HASH_WIDTH + x] ?? 0;
      const right = pixels[y * HASH_WIDTH + x + 1] ?? 0;
      bits = (bits << 1n) | (left > right ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

/** dHash, or null when the bytes cannot be decoded (the caller keeps the exact sha256 check). */
export async function tryDHash(bytes: Uint8Array): Promise<string | null> {
  try {
    return await dHash(bytes);
  } catch {
    return null;
  }
}

/** Number of differing bits between two 64-bit hex hashes. */
export function hammingDistance(a: string, b: string): number {
  if (!PHASH.test(a) || !PHASH.test(b)) return Number.POSITIVE_INFINITY;
  let diff = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (diff > 0n) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}

/** The closest hash within the threshold, or null. */
export function nearestWithin<T extends { phash: string | null }>(
  hash: string,
  candidates: readonly T[],
  maxDistance = NEAR_DUPLICATE_MAX_DISTANCE,
): { item: T; distance: number } | null {
  let best: { item: T; distance: number } | null = null;
  for (const item of candidates) {
    if (!item.phash) continue;
    const distance = hammingDistance(hash, item.phash);
    if (distance <= maxDistance && (!best || distance < best.distance)) best = { item, distance };
  }
  return best;
}
