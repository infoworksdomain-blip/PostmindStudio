import { createHash } from 'node:crypto';
import type { ImageSource, PrismaClient } from '@prisma/client';
import { imageSize } from 'image-size';
import type { AssetStorage } from '../storage';
import { safeGet } from '../scan/safe-fetch';
import { SCAN_USER_AGENT } from '../scan/fetch';

// BACKLOG 6.4 / Addendum A6.3 — put one image into a business's library:
// download (SSRF-guarded, capped) → check it is a real raster image → drop small ones
// (< 500px long edge) → fingerprint (sha256 of the bytes) → dedup per business →
// for scraped images, drop any whose bytes match a known stock image → store in S3 → row.
//
// Fingerprint note: the spec asks for a perceptual hash. An exact sha256 is used for now — it
// catches byte-identical copies (the common case for stock photos re-hosted unchanged) but not
// resized or re-encoded ones. See the Phase 6 review list.

export const MIN_LONG_EDGE_PX = 500;
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 30_000;
const RASTER_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

const TRACKER_OR_ICON =
  /(favicon|sprite|spacer|pixel|tracking|blank\.gif|\/icons?\/|social[-_]?icon|share[-_]?button)/i;
const SOCIAL_OR_TRACKER_HOSTS = [
  'facebook.com',
  'facebook.net',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'instagram.com',
  'pinterest.com',
  'doubleclick.net',
  'google-analytics.com',
  'googletagmanager.com',
];

export type IngestOutcome =
  | { status: 'created'; id: string }
  | { status: 'duplicate'; id: string }
  | {
      status: 'skipped';
      reason: 'too_small' | 'not_image' | 'too_large' | 'stock_match' | 'filtered';
    };

export interface IngestDeps {
  db: PrismaClient;
  storage: AssetStorage;
  bucket: string;
  fetchImpl: typeof fetch;
}

export interface IngestInput {
  organisationId: string;
  businessId: string;
  source: ImageSource;
  sourceUrl?: string | null;
  sourceProvider?: string | null;
  /** Either bytes (upload / generated) or a URL to download. */
  bytes?: Uint8Array;
  downloadUrl?: string;
  altText?: string | null;
  tags?: string[];
  licenseNotes?: string | null;
  generatedFromPrompt?: string | null;
}

/** Cheap pre-download filter for scraped <img> tags (A6.3: tracking pixels, social icons). */
export function looksLikeIconOrTracker(input: {
  url: string;
  declaredWidth: number | null;
  declaredHeight: number | null;
}): boolean {
  const { hostname, pathname } = new URL(input.url);
  if (SOCIAL_OR_TRACKER_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`)))
    return true;
  if (TRACKER_OR_ICON.test(pathname)) return true;
  if (/\.svg$/i.test(pathname)) return true;
  const declared = Math.max(input.declaredWidth ?? 0, input.declaredHeight ?? 0);
  return declared > 0 && declared < MIN_LONG_EDGE_PX;
}

export function fingerprintOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function normaliseTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))]
    .map((t) => t.slice(0, 60))
    .slice(0, 30);
}

function inspect(bytes: Uint8Array): { width: number; height: number; type: string } | null {
  try {
    const size = imageSize(bytes);
    if (!size.type || !(size.type in RASTER_TYPES) || !size.width || !size.height) return null;
    return { width: size.width, height: size.height, type: size.type };
  } catch {
    return null;
  }
}

export async function ingestImage(deps: IngestDeps, input: IngestInput): Promise<IngestOutcome> {
  let bytes = input.bytes;
  if (!bytes) {
    if (!input.downloadUrl) return { status: 'skipped', reason: 'filtered' };
    const res = await safeGet(input.downloadUrl, {
      fetchImpl: deps.fetchImpl,
      userAgent: SCAN_USER_AGENT,
      timeoutMs: IMAGE_TIMEOUT_MS,
      maxBytes: MAX_IMAGE_BYTES + 1,
      accept: 'image/*',
    });
    if (res.status >= 400) return { status: 'skipped', reason: 'not_image' };
    if (res.truncated) return { status: 'skipped', reason: 'too_large' };
    bytes = res.body;
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) return { status: 'skipped', reason: 'too_large' };
  const info = inspect(bytes);
  if (!info) return { status: 'skipped', reason: 'not_image' };
  if (Math.max(info.width, info.height) < MIN_LONG_EDGE_PX)
    return { status: 'skipped', reason: 'too_small' };

  const fingerprint = fingerprintOf(bytes);
  const existing = await deps.db.imageLibraryItem.findUnique({
    where: { businessId_fingerprint: { businessId: input.businessId, fingerprint } },
    select: { id: true },
  });
  if (existing) return { status: 'duplicate', id: existing.id };
  if (input.source === 'SCRAPED') {
    const stock = await deps.db.imageLibraryItem.findFirst({
      where: { fingerprint, source: 'STOCK' },
      select: { id: true },
    });
    if (stock) return { status: 'skipped', reason: 'stock_match' };
  }

  const key = `orgs/${input.organisationId}/businesses/${encodeURIComponent(input.businessId)}/images/${fingerprint}.${info.type}`;
  await deps.storage.put({
    bucket: deps.bucket,
    key,
    body: bytes,
    contentType: RASTER_TYPES[info.type] as string,
  });
  try {
    const row = await deps.db.imageLibraryItem.create({
      data: {
        organisationId: input.organisationId,
        businessId: input.businessId,
        source: input.source,
        sourceUrl: input.sourceUrl?.slice(0, 2_000) ?? null,
        sourceProvider: input.sourceProvider ?? null,
        s3Bucket: deps.bucket,
        s3Key: key,
        widthPx: info.width,
        heightPx: info.height,
        fileSizeBytes: bytes.byteLength,
        tags: normaliseTags(input.tags ?? []),
        altText: input.altText?.slice(0, 1_000) ?? null,
        fingerprint,
        generatedFromPrompt: input.generatedFromPrompt ?? null,
        licenseNotes: input.licenseNotes ?? null,
      },
      select: { id: true },
    });
    return { status: 'created', id: row.id };
  } catch (err) {
    // A concurrent ingest of the same bytes won the unique (businessId, fingerprint) race.
    if ((err as { code?: string }).code === 'P2002') {
      const winner = await deps.db.imageLibraryItem.findUniqueOrThrow({
        where: { businessId_fingerprint: { businessId: input.businessId, fingerprint } },
        select: { id: true },
      });
      return { status: 'duplicate', id: winner.id };
    }
    throw err;
  }
}

/** Unsplash-style hotlinked stock: no copy is stored, only metadata and the hotlink URL. */
export async function recordHotlinkedImage(
  db: PrismaClient,
  input: {
    organisationId: string;
    businessId: string;
    provider: string;
    providerImageId: string;
    url: string;
    width: number;
    height: number;
    altText: string | null;
    tags: string[];
    licenseNotes: string;
    pageUrl: string | null;
  },
): Promise<IngestOutcome> {
  if (Math.max(input.width, input.height) < MIN_LONG_EDGE_PX)
    return { status: 'skipped', reason: 'too_small' };
  const fingerprint = `${input.provider}:${input.providerImageId}`;
  const row = await db.imageLibraryItem.upsert({
    where: { businessId_fingerprint: { businessId: input.businessId, fingerprint } },
    create: {
      organisationId: input.organisationId,
      businessId: input.businessId,
      source: 'STOCK',
      sourceUrl: input.pageUrl,
      sourceProvider: input.provider,
      s3Bucket: '',
      s3Key: '',
      publicUrl: input.url,
      widthPx: input.width,
      heightPx: input.height,
      fileSizeBytes: 0,
      tags: normaliseTags(input.tags),
      altText: input.altText,
      fingerprint,
      licenseNotes: input.licenseNotes,
    },
    update: {},
    select: { id: true, createdAt: true },
  });
  return { status: 'created', id: row.id };
}

/** Text used for an image's embedding: what the image is described as. */
export function embeddingText(item: {
  altText: string | null;
  tags: string[];
  generatedFromPrompt: string | null;
}): string {
  return [item.altText, item.generatedFromPrompt, item.tags.join(', ')]
    .filter(Boolean)
    .join('. ')
    .slice(0, 2_000);
}

export function vectorLiteral(values: number[]): string {
  return `[${values.map((v) => (Number.isFinite(v) ? v : 0)).join(',')}]`;
}
