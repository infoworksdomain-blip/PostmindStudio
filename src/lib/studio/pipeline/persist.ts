import { ProviderError } from '../../errors';
import type { AssetStorage, StoredObject } from '../storage';

// Copy a provider-hosted output into Studio's own bucket. Runway links expire within 24–48h and
// Shotstack deletes renders after 24h, so nothing downstream may depend on provider URLs.

export const MAX_COPY_BYTES = 1_000_000_000; // 1 GB: well above a 6-minute 1080p render
const COPY_TIMEOUT_MS = 10 * 60_000;

export interface CopiedObject extends StoredObject {
  bytes: number;
  contentType: string;
}

/** Read a response body, aborting as soon as it exceeds MAX_COPY_BYTES (no full buffering first). */
async function readCapped(res: Response, providerId: string): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_COPY_BYTES) {
      await reader.cancel();
      throw new ProviderError(
        providerId,
        'invalid_request',
        `Output exceeds ${MAX_COPY_BYTES} bytes`,
        false,
      );
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function copyUrlToStorage(
  storage: AssetStorage,
  input: {
    url: string;
    bucket: string;
    key: string;
    fallbackContentType: string;
    providerId: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<CopiedObject> {
  let res: Response;
  try {
    res = await fetchImpl(input.url, { signal: AbortSignal.timeout(COPY_TIMEOUT_MS) });
  } catch (err) {
    throw new ProviderError(
      input.providerId,
      'provider_unavailable',
      `Download failed: ${(err as Error).message}`,
      true,
    );
  }
  if (!res.ok) {
    // An expired output link can't be fixed by retrying the download; regenerate instead.
    const retryable = res.status >= 500 || res.status === 429;
    throw new ProviderError(
      input.providerId,
      retryable ? 'provider_unavailable' : 'result_expired',
      `Download failed: HTTP ${res.status}`,
      true,
    );
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_COPY_BYTES) {
    throw new ProviderError(
      input.providerId,
      'invalid_request',
      `Output too large (${declared} bytes)`,
      false,
    );
  }
  const body = await readCapped(res, input.providerId);
  if (body.byteLength === 0) {
    throw new ProviderError(input.providerId, 'unknown', 'Downloaded output is empty', true);
  }
  const contentType =
    res.headers.get('content-type')?.split(';')[0]?.trim() || input.fallbackContentType;
  const stored = await storage.put({ bucket: input.bucket, key: input.key, body, contentType });
  return { ...stored, bytes: body.byteLength, contentType };
}
