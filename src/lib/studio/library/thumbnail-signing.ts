import type { AssetStorage } from '../storage';
import { R2_MAX_PRESIGN_SEC } from '../storage-client';

// BACKLOG 20.15 — cache-friendly library thumbnails.
//
// A presigned URL normally changes on every request (X-Amz-Date is "now"), so a browser can never
// reuse a thumbnail it already downloaded and every page view is another R2 GET. Thumbnails are
// signed instead as of the start of a fixed window (floor(now / window) * window): every request
// in the same window gets the byte-identical URL, and the object's own Cache-Control (set at
// ingest, THUMBNAIL_CACHE_CONTROL) lets the browser keep it. The URL stays valid for the rest of
// the window plus a margin, so a page rendered just before the window ends still loads.
//
// Thumbnails are content-addressed: library/<sha256 of the source>-thumb.jpg (ingest.ts), never
// rewritten (re-analysis keeps the thumbnail), so caching them for a week is safe.

/** One signing window: every thumbnail URL is the same for a whole UTC day. */
export const THUMB_SIGNING_WINDOW_SEC = 24 * 60 * 60;
/** Extra validity after the window ends (a page loaded at 23:59 still shows its thumbnails). */
export const THUMB_SIGNING_MARGIN_SEC = 60 * 60;
/** Validity counted from the window start: the window plus the margin (25 h). */
export const THUMB_URL_TTL_SEC = THUMB_SIGNING_WINDOW_SEC + THUMB_SIGNING_MARGIN_SEC;

/** Stored on thumbnails and previews at upload (and backfilled): a week, immutable. */
export const THUMBNAIL_CACHE_CONTROL = 'public, max-age=604800, immutable';

export interface StableSigning {
  signingDate: Date;
  expiresInSec: number;
}

/**
 * Signing time and expiry for `nowMs`. The expiry never exceeds `maxPresignSec` (R2 and SigV4
 * both cap presigned URLs at 7 days).
 */
export function stableSigning(
  nowMs: number,
  windowSec: number = THUMB_SIGNING_WINDOW_SEC,
  marginSec: number = THUMB_SIGNING_MARGIN_SEC,
  maxPresignSec: number = R2_MAX_PRESIGN_SEC,
): StableSigning {
  const windowMs = windowSec * 1000;
  const start = Math.floor(nowMs / windowMs) * windowMs;
  return {
    signingDate: new Date(start),
    expiresInSec: Math.min(windowSec + marginSec, maxPresignSec),
  };
}

/** The thumbnail's URL for this signing window (identical for every request in it). */
export function signThumbnail(
  storage: AssetStorage,
  bucket: string,
  key: string,
  nowMs: number,
): Promise<string> {
  const { signingDate, expiresInSec } = stableSigning(nowMs);
  return storage.signedUrl(bucket, key, expiresInSec, { signingDate });
}
