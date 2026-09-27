import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { ValidationError } from '../errors';

// BACKLOG 13.15 — stream large objects (corpus sources ≤ 200 MB) into S3 without holding them in
// memory: an S3 multipart upload fed PART_SIZE chunks at a time. S3 limits
// (https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html): parts 5 MiB–5 GiB except
// the last, at most 10,000 parts. A failed upload is aborted so no orphaned parts are billed.

export const PART_SIZE = 8 * 1024 * 1024;
export const MAX_PARTS = 10_000;

/** Re-chunks a byte stream into parts of exactly `size` bytes (the last may be shorter). */
export async function* rechunk(
  source: AsyncIterable<Uint8Array>,
  size = PART_SIZE,
): AsyncGenerator<Uint8Array> {
  let buffer = new Uint8Array(size);
  let filled = 0;
  for await (const chunk of source) {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const take = Math.min(size - filled, chunk.byteLength - offset);
      buffer.set(chunk.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === size) {
        yield buffer;
        buffer = new Uint8Array(size);
        filled = 0;
      }
    }
  }
  if (filled > 0) yield buffer.slice(0, filled);
}

export interface StreamPutInput {
  bucket: string;
  key: string;
  body: AsyncIterable<Uint8Array>;
  contentType: string;
}

export async function s3PutStream(
  client: S3Client,
  input: StreamPutInput,
): Promise<{ bucket: string; key: string; bytes: number }> {
  const created = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: input.bucket,
      Key: input.key,
      ContentType: input.contentType,
    }),
  );
  const uploadId = created.UploadId;
  if (!uploadId) throw new ValidationError(`No upload id for s3://${input.bucket}/${input.key}`);
  const parts: Array<{ ETag: string; PartNumber: number }> = [];
  let bytes = 0;
  try {
    for await (const part of rechunk(input.body)) {
      const partNumber = parts.length + 1;
      if (partNumber > MAX_PARTS) throw new ValidationError('Object has too many parts for S3');
      const res = await client.send(
        new UploadPartCommand({
          Bucket: input.bucket,
          Key: input.key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: part,
        }),
      );
      if (!res.ETag) throw new ValidationError(`S3 returned no ETag for part ${partNumber}`);
      parts.push({ ETag: res.ETag, PartNumber: partNumber });
      bytes += part.byteLength;
    }
    if (parts.length === 0) throw new ValidationError('Nothing to upload: the stream was empty');
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
    return { bucket: input.bucket, key: input.key, bytes };
  } catch (err) {
    await client
      .send(
        new AbortMultipartUploadCommand({
          Bucket: input.bucket,
          Key: input.key,
          UploadId: uploadId,
        }),
      )
      .catch(() => undefined);
    throw err;
  }
}

/** Server-side copy within a bucket (single CopyObject: objects ≤ 5 GB). */
export async function s3Copy(
  client: S3Client,
  bucket: string,
  fromKey: string,
  toKey: string,
): Promise<void> {
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: toKey,
      CopySource: `${bucket}/${fromKey.split('/').map(encodeURIComponent).join('/')}`,
    }),
  );
}
