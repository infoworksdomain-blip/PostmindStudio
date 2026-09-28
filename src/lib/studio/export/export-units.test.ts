import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { redactSecrets } from './collect';
import { crc32, createZip } from './zip';

// 15.E1 building blocks: the ZIP writer (readable by an independent unzip) and the secret scrub.

describe('ZIP writer', () => {
  it('computes the standard CRC-32 check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('writes a deflated archive that fflate can read back, with UTF-8 names', () => {
    const big = 'x'.repeat(10_000);
    const zip = createZip([
      { name: 'manifest.json', data: new TextEncoder().encode('{"a":1}') },
      { name: 'tables/vidéo.json', data: new TextEncoder().encode(big) },
      { name: 'empty.json', data: new Uint8Array() },
    ]);
    expect(zip.byteLength).toBeLessThan(big.length);
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(['empty.json', 'manifest.json', 'tables/vidéo.json']);
    expect(strFromU8(files['manifest.json'] as Uint8Array)).toBe('{"a":1}');
    expect(strFromU8(files['tables/vidéo.json'] as Uint8Array)).toBe(big);
  });
});

describe('redactSecrets', () => {
  it('drops token / secret / password / embedding keys at any depth, keeps dates and values', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    expect(
      redactSecrets([
        {
          id: 'c1',
          encryptedAccessToken: 'sealed',
          nested: {
            tokenHash: 'h',
            clientSecret: 's',
            ok: 1,
            list: [{ password: 'p', keep: true }],
          },
          embedding: [0.1],
          at,
        },
      ]),
    ).toEqual([{ id: 'c1', nested: { ok: 1, list: [{ keep: true }] }, at }]);
  });
});
