import type { UploadKind, VideoUpload } from '@prisma/client';
import { ValidationError } from '../../errors';
import type { MediaProbe } from '../pipeline/media-probe';
import { SAFE_FONT } from '../pipeline/edl-time';
import { parseFontFamily, parseImage, type ImageInfo } from '../uploads/brand-files';
import type { UploadDeps } from '../uploads/signer';

// BACKLOG 15.B1 — brand-kit media uploads (spec 10.1 logo, watermark, intro/outro cards and
// "Google Fonts or uploaded TTF"; A11.5 "Uploaded fonts require the user to confirm licence for
// commercial embedding"). They reuse the 13.5 presigned-PUT flow (services/uploads.ts); this
// module holds the per-kind rules and the completion checks, which read the file's bytes:
//   - brand_logo: PNG with transparency (spec 10.1);
//   - brand_watermark: PNG (transparency recommended, not required);
//   - brand_card: PNG/JPEG still or a short MP4 (probed with ffprobe);
//   - brand_font: TrueType/OpenType; the embedded family name is stored, because Shotstack
//     matches custom fonts by it. DEVIATION: no WOFF2 is produced for the editor — browsers load
//     TTF/OTF directly in @font-face (CSS Fonts 4 `format("truetype" | "opentype")`), and adding a
//     WOFF2 encoder would add a dependency for a size saving only.

export const BRAND_KINDS = ['brand_logo', 'brand_watermark', 'brand_card', 'brand_font'] as const;
export type BrandKind = (typeof BRAND_KINDS)[number];

export const BRAND_CONTENT_TYPES: Record<BrandKind, readonly string[]> = {
  brand_logo: ['image/png'],
  brand_watermark: ['image/png'],
  brand_card: ['image/png', 'image/jpeg', 'video/mp4'],
  brand_font: ['font/ttf', 'font/otf'],
};

export const BRAND_LIMITS: Record<BrandKind, { maxBytes: number }> = {
  brand_logo: { maxBytes: 10 * 1024 * 1024 },
  brand_watermark: { maxBytes: 10 * 1024 * 1024 },
  brand_card: { maxBytes: 100 * 1024 * 1024 },
  brand_font: { maxBytes: 10 * 1024 * 1024 },
};

/** A card video longer than this is rejected (the timeline shows at most 6 s of it). */
export const MAX_CARD_VIDEO_SEC = 30;
const MIN_IMAGE_EDGE_PX = 64;
/** Bytes read to parse an image header (PNG chunks before IDAT, JPEG SOF). */
const IMAGE_HEAD_BYTES = 256 * 1024;

export const BRAND_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'video/mp4': 'mp4',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
};

export const UPLOAD_KIND_ENUM: Record<BrandKind, UploadKind> = {
  brand_logo: 'BRAND_LOGO',
  brand_watermark: 'BRAND_WATERMARK',
  brand_card: 'BRAND_CARD',
  brand_font: 'BRAND_FONT',
};

export function isBrandKind(kind: string): kind is BrandKind {
  return (BRAND_KINDS as readonly string[]).includes(kind);
}

export function isBrandUploadKind(kind: UploadKind): boolean {
  return Object.values(UPLOAD_KIND_ENUM).includes(kind);
}

export function apiKindOf(kind: UploadKind): string {
  return kind.toLowerCase();
}

/** Why the create request is not acceptable for a brand kind, or null. */
export function brandCreateProblem(input: {
  kind: BrandKind;
  contentType: string;
  businessId?: string;
  licenceConfirmed?: boolean;
}): string | null {
  if (!BRAND_CONTENT_TYPES[input.kind].includes(input.contentType))
    return `${input.kind} accepts ${BRAND_CONTENT_TYPES[input.kind].join(', ')}`;
  if (!input.businessId) return 'businessId is required for brand-kit media';
  if (input.kind === 'brand_font' && input.licenceConfirmed !== true)
    return 'Confirm that the font licence allows commercial embedding (licenceConfirmed: true)';
  return null;
}

export interface BrandCompletion {
  widthPx?: number;
  heightPx?: number;
  durationSec?: number;
  fontFamily?: string;
}

function imageProblem(kind: UploadKind, info: ImageInfo | null): string | null {
  if (!info) return 'the file is not a PNG or JPEG image';
  if (Math.min(info.width, info.height) < MIN_IMAGE_EDGE_PX)
    return `the image must be at least ${MIN_IMAGE_EDGE_PX}px on each side`;
  if ((kind === 'BRAND_LOGO' || kind === 'BRAND_WATERMARK') && info.format !== 'png')
    return 'the file must be a PNG';
  if (kind === 'BRAND_LOGO' && !info.hasAlpha)
    return 'the logo must be a PNG with transparency (spec 10.1)';
  return null;
}

async function checkCardVideo(uploads: UploadDeps, upload: VideoUpload): Promise<BrandCompletion> {
  let probe: MediaProbe;
  try {
    probe = await uploads.media.probe(
      await uploads.storage.signedUrl(upload.s3Bucket, upload.s3Key),
    );
  } catch {
    throw new ValidationError('not a readable video');
  }
  if (!(probe.width > 0 && probe.height > 0))
    throw new ValidationError('the file has no video stream');
  if (!(probe.durationSec > 0) || probe.durationSec > MAX_CARD_VIDEO_SEC)
    throw new ValidationError(`a card video must be at most ${MAX_CARD_VIDEO_SEC}s long`);
  return { widthPx: probe.width, heightPx: probe.height, durationSec: probe.durationSec };
}

/**
 * Check an uploaded brand file (size already verified by the caller). Throws ValidationError
 * with a user-facing reason when the file is unusable; the caller removes it.
 */
export async function checkBrandFile(
  uploads: UploadDeps,
  upload: VideoUpload,
  size: number,
): Promise<BrandCompletion> {
  if (upload.kind === 'BRAND_CARD' && upload.contentType === 'video/mp4')
    return checkCardVideo(uploads, upload);
  if (upload.kind === 'BRAND_FONT') {
    const bytes = await uploads.storage.readRange(upload.s3Bucket, upload.s3Key, 0, size - 1);
    const family = parseFontFamily(bytes);
    if (!family) throw new ValidationError('the file is not a TrueType or OpenType font');
    if (!SAFE_FONT.test(family))
      throw new ValidationError(
        `the font's family name "${family.slice(0, 80)}" has characters Studio cannot embed`,
      );
    return { fontFamily: family };
  }
  const head = await uploads.storage.readRange(
    upload.s3Bucket,
    upload.s3Key,
    0,
    Math.min(size, IMAGE_HEAD_BYTES) - 1,
  );
  const info = parseImage(head);
  const problem = imageProblem(upload.kind, info);
  if (problem || !info) throw new ValidationError(problem ?? 'unreadable image');
  return { widthPx: info.width, heightPx: info.height };
}
