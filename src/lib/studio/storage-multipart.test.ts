import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { rechunk, s3Copy, s3PutStream } from './storage-multipart';

async function* chunks(...sizes: number[]): AsyncGenerator<Uint8Array> {
  let n = 0;
  for (const size of sizes) yield new Uint8Array(size).fill((n += 1));
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const part of source) out.push(part);
  return out;
}

describe('rechunk', () => {
  it('produces fixed-size parts with a short last part, preserving bytes', async () => {
    const parts = await collect(rechunk(chunks(3, 5, 1, 4), 4));
    expect(parts.map((p) => p.byteLength)).toEqual([4, 4, 4, 1]);
    expect([...parts.flatMap((p) => [...p])]).toEqual([1, 1, 1, 2, 2, 2, 2, 2, 3, 4, 4, 4, 4]);
  });

  it('yields nothing for an empty stream', async () => {
    expect(await collect(rechunk(chunks(), 4))).toEqual([]);
  });
});

function fakeClient(failOnPart?: number) {
  const sent: unknown[] = [];
  const send = vi.fn(async (command: unknown) => {
    sent.push(command);
    if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'up-1' };
    if (command instanceof UploadPartCommand) {
      if (command.input.PartNumber === failOnPart) throw new Error('part failed');
      return { ETag: `"etag-${command.input.PartNumber}"` };
    }
    return {};
  });
  return { client: { send } as unknown as S3Client, sent };
}

describe('s3PutStream', () => {
  it('creates the upload, sends 8 MiB parts in order and completes it', async () => {
    const { client, sent } = fakeClient();
    const size = 8 * 1024 * 1024;
    const result = await s3PutStream(client, {
      bucket: 'lib',
      key: 'library/staging/x.mp4',
      body: chunks(size, size / 2),
      contentType: 'video/mp4',
    });
    expect(result).toEqual({ bucket: 'lib', key: 'library/staging/x.mp4', bytes: size * 1.5 });
    const parts = sent.filter((c): c is UploadPartCommand => c instanceof UploadPartCommand);
    expect(parts.map((p) => p.input.PartNumber)).toEqual([1, 2]);
    const complete = sent.at(-1) as CompleteMultipartUploadCommand;
    expect(complete).toBeInstanceOf(CompleteMultipartUploadCommand);
    expect(complete.input.MultipartUpload?.Parts).toEqual([
      { ETag: '"etag-1"', PartNumber: 1 },
      { ETag: '"etag-2"', PartNumber: 2 },
    ]);
  });

  it('aborts the upload when a part fails or the stream is empty', async () => {
    const failing = fakeClient(1);
    await expect(
      s3PutStream(failing.client, { bucket: 'b', key: 'k', body: chunks(10), contentType: 'x' }),
    ).rejects.toThrow('part failed');
    expect(failing.sent.at(-1)).toBeInstanceOf(AbortMultipartUploadCommand);

    const empty = fakeClient();
    await expect(
      s3PutStream(empty.client, { bucket: 'b', key: 'k', body: chunks(), contentType: 'x' }),
    ).rejects.toThrow('empty');
    expect(empty.sent.at(-1)).toBeInstanceOf(AbortMultipartUploadCommand);
  });

  it('aborts when the source stream throws (e.g. over the size cap)', async () => {
    const { client, sent } = fakeClient();
    async function* broken(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(3);
      throw new Error('larger than 200 MB');
    }
    await expect(
      s3PutStream(client, { bucket: 'b', key: 'k', body: broken(), contentType: 'x' }),
    ).rejects.toThrow('200 MB');
    expect(sent.at(-1)).toBeInstanceOf(AbortMultipartUploadCommand);
  });
});

describe('s3Copy', () => {
  it('copies within the bucket with an encoded CopySource', async () => {
    const { client, sent } = fakeClient();
    await s3Copy(client, 'lib', 'library/staging/a b.mp4', 'library/abc.mp4');
    const copy = sent[0] as CopyObjectCommand;
    expect(copy).toBeInstanceOf(CopyObjectCommand);
    expect(copy.input).toMatchObject({
      Bucket: 'lib',
      Key: 'library/abc.mp4',
      CopySource: 'lib/library/staging/a%20b.mp4',
    });
  });
});
