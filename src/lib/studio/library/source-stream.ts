import { ValidationError } from '../../errors';
import type { PipelineDeps } from '../pipeline/deps';
import { safeOpen } from '../scan/safe-fetch';
import { assertAllowedS3Source, isS3Url, parseS3Url } from './corpus-source';

// BACKLOG 13.15 — corpus sources as byte streams, so ingestion never holds a whole video in
// memory (was: ≤ 200 MB buffered per job × STUDIO_LIBRARY_CONCURRENCY). The same rules as the
// buffered read apply: https through the SSRF guard, s3:// only from STUDIO_CORPUS_S3_BUCKETS,
// and a hard MAX_SOURCE_BYTES cap enforced while streaming.

export const SOURCE_TIMEOUT_MS = 10 * 60_000;
/** Ranged-read window for s3:// sources. */
export const S3_READ_WINDOW = 8 * 1024 * 1024;
const USER_AGENT = 'PostMindStudio/1.0 (+https://studio.postmind.ai/bot)';

/** Fails once more than `maxBytes` have passed through. */
export async function* capped(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
): AsyncGenerator<Uint8Array> {
  let total = 0;
  for await (const chunk of source) {
    total += chunk.byteLength;
    if (total > maxBytes)
      throw new ValidationError(`Source video is larger than ${maxBytes / 1024 / 1024} MB`);
    yield chunk;
  }
  if (total === 0) throw new ValidationError('Source is empty');
}

async function* readerChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    // Stops the download when the consumer gives up (cap exceeded, upload failed).
    await reader.cancel().catch(() => undefined);
  }
}

async function* s3Chunks(
  deps: PipelineDeps,
  bucket: string,
  key: string,
  size: number,
): AsyncGenerator<Uint8Array> {
  for (let start = 0; start < size; start += S3_READ_WINDOW) {
    const end = Math.min(size, start + S3_READ_WINDOW) - 1;
    yield await deps.storage.readRange(bucket, key, start, end);
  }
}

/** The source as a capped byte stream. Checks (allow-list, size, HTTP status) run up front. */
export async function openSourceStream(
  deps: PipelineDeps,
  sourceUrl: string,
  maxBytes: number,
): Promise<AsyncIterable<Uint8Array>> {
  if (isS3Url(sourceUrl)) {
    const source = parseS3Url(sourceUrl);
    assertAllowedS3Source(source, deps.config.corpusS3Buckets ?? []);
    const size = await deps.storage.size(source.bucket, source.key);
    if (size > maxBytes) throw new ValidationError('Source video is larger than 200 MB');
    if (size <= 0) throw new ValidationError('Source object is empty');
    return capped(s3Chunks(deps, source.bucket, source.key, size), maxBytes);
  }
  const res = await safeOpen(sourceUrl, {
    fetchImpl: deps.scan.pageFetch,
    userAgent: USER_AGENT,
    timeoutMs: SOURCE_TIMEOUT_MS,
    accept: 'video/*',
  });
  if (res.status >= 400) {
    await res.body?.cancel().catch(() => undefined);
    throw new ValidationError(`Source returned HTTP ${res.status}`);
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new ValidationError('Source video is larger than 200 MB');
  }
  if (!res.body) throw new ValidationError('Source is empty');
  return capped(readerChunks(res.body), maxBytes);
}

/** Passes chunks through while feeding them to `onChunk` (e.g. a running sha256). */
export async function* tap(
  source: AsyncIterable<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of source) {
    onChunk(chunk);
    yield chunk;
  }
}
