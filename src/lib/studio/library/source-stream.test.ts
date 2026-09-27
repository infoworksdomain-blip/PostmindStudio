import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../../../../test/helpers/memory-storage';
import type { PipelineDeps } from '../pipeline/deps';
import { capped, openSourceStream, S3_READ_WINDOW, tap } from './source-stream';

async function bytesOf(source: AsyncIterable<Uint8Array>): Promise<number[]> {
  const out: number[] = [];
  for await (const chunk of source) out.push(...chunk);
  return out;
}

async function* from(...chunks: number[][]): AsyncGenerator<Uint8Array> {
  for (const c of chunks) yield new Uint8Array(c);
}

function deps(options: { fetch?: typeof fetch; buckets?: string[] } = {}) {
  const { storage, objects } = memoryStorage();
  const d = {
    storage,
    config: {
      corpusS3Buckets: (options.buckets ?? []).map((bucket) => ({ bucket, prefix: '' })),
    },
    scan: { pageFetch: options.fetch ?? (async () => new Response('')) },
  } as unknown as PipelineDeps;
  return { d, objects };
}

describe('capped / tap', () => {
  it('passes bytes through and fails past the cap or when empty', async () => {
    expect(await bytesOf(capped(from([1, 2], [3]), 3))).toEqual([1, 2, 3]);
    await expect(bytesOf(capped(from([1, 2], [3, 4]), 3))).rejects.toThrow('larger than');
    await expect(bytesOf(capped(from(), 3))).rejects.toThrow('empty');
  });

  it('tap sees every chunk', async () => {
    const seen: number[] = [];
    expect(await bytesOf(tap(from([1], [2, 3]), (c) => seen.push(c.byteLength)))).toEqual([
      1, 2, 3,
    ]);
    expect(seen).toEqual([1, 2]);
  });
});

describe('openSourceStream', () => {
  it('streams an https source through the SSRF guard (public URL only)', async () => {
    const { d } = deps({
      fetch: async () =>
        new Response(new Uint8Array([7, 8, 9]), { headers: { 'content-type': 'video/mp4' } }),
    });
    expect(await bytesOf(await openSourceStream(d, 'https://cdn.example/a.mp4', 10))).toEqual([
      7, 8, 9,
    ]);
    await expect(openSourceStream(d, 'http://127.0.0.1/a.mp4', 10)).rejects.toThrow('public');
  });

  it('refuses HTTP errors and a declared length over the cap before reading', async () => {
    const notFound = deps({ fetch: async () => new Response('nope', { status: 404 }) });
    await expect(openSourceStream(notFound.d, 'https://cdn.example/a.mp4', 10)).rejects.toThrow(
      'HTTP 404',
    );
    const huge = deps({
      fetch: async () =>
        new Response(new Uint8Array(4), { headers: { 'content-length': '999999' } }),
    });
    await expect(openSourceStream(huge.d, 'https://cdn.example/a.mp4', 10)).rejects.toThrow(
      'larger than',
    );
  });

  it('reads allow-listed s3 objects in ranged windows', async () => {
    const { d, objects } = deps({ buckets: ['corpus'] });
    const body = new Uint8Array(S3_READ_WINDOW + 5).fill(1);
    objects.set('corpus/v/a.mp4', { body, contentType: 'video/mp4' });
    let count = 0;
    let total = 0;
    for await (const chunk of await openSourceStream(d, 's3://corpus/v/a.mp4', body.byteLength)) {
      count += 1;
      total += chunk.byteLength;
    }
    expect({ count, total }).toEqual({ count: 2, total: body.byteLength });
    await expect(openSourceStream(d, 's3://other/v/a.mp4', 10)).rejects.toThrow(
      'STUDIO_CORPUS_S3_BUCKETS',
    );
    await expect(openSourceStream(d, 's3://corpus/v/a.mp4', 10)).rejects.toThrow('200 MB');
  });
});
