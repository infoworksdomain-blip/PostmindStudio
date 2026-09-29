import type { BrandKit, PrismaClient, UploadKind, VideoUpload } from '@prisma/client';
import { fontFamilyFor, scriptOf } from '../i18n/scripts';
import { PLAN_CATALOGUE } from '../billing/catalogue';
import type { PlanTier } from '../providers/router';
import type { AssetStorage } from '../storage';
import type { BrandCard, BrandImage, BrandMedia } from './edl-brand';
import { SAFE_FONT } from './edl-time';

// BACKLOG 15.B1 + operator decisions P2/P6 — what composition needs from the brand kit:
//   - the kit (project's kit, else the business default; soft-deleted kits are never a default);
//   - its media uploads (logo, watermark, intro/outro cards) as signed URLs;
//   - font sources for Shotstack's timeline.fonts: an uploaded font (brand_kits.fontPrimary =
//     "upload:<uploadId>") by signed URL and its embedded family name; a named font from the
//     fonts host (STUDIO_FONTS_BASE_URL/<FamilyNoSpaces>.ttf, the overlay convention); for
//     non-Latin languages the script's Noto family (i18n/scripts.ts);
//   - white-label (P2): ENTERPRISE, or org_policies.whiteLabel. White-label outputs never carry
//     a Studio mark; others get the optional platform end card (STUDIO_MADE_WITH_CARD_URL).

export const UPLOADED_FONT_PREFIX = 'upload:';

type Db = Pick<PrismaClient, 'brandKit' | 'videoUpload' | 'orgPolicy'>;

export async function resolveProjectBrandKit(
  db: Pick<PrismaClient, 'brandKit'>,
  project: { organisationId: string; businessId: string; brandKitId: string | null },
): Promise<BrandKit | null> {
  // A project keeps the kit it was made with, even if the kit was archived later.
  if (project.brandKitId)
    return db.brandKit.findFirst({
      where: { id: project.brandKitId, organisationId: project.organisationId },
    });
  return db.brandKit.findFirst({
    where: {
      organisationId: project.organisationId,
      businessId: project.businessId,
      isDefault: true,
      deletedAt: null,
    },
  });
}

export function uploadedFontId(value: string | null | undefined): string | null {
  return value?.startsWith(UPLOADED_FONT_PREFIX) ? value.slice(UPLOADED_FONT_PREFIX.length) : null;
}

async function readyUploads(db: Db, organisationId: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, VideoUpload>();
  const rows = await db.videoUpload.findMany({
    where: { id: { in: ids }, organisationId, state: 'READY' },
  });
  return new Map(rows.map((r) => [r.id, r]));
}

async function image(
  storage: AssetStorage,
  row: VideoUpload | undefined,
  kind: UploadKind,
): Promise<BrandImage | undefined> {
  if (!row || row.kind !== kind || !row.widthPx || !row.heightPx) return undefined;
  return {
    src: await storage.signedUrl(row.s3Bucket, row.s3Key),
    width: row.widthPx,
    height: row.heightPx,
  };
}

async function card(
  storage: AssetStorage,
  row: VideoUpload | undefined,
): Promise<BrandCard | undefined> {
  if (!row || row.kind !== 'BRAND_CARD') return undefined;
  return {
    src: await storage.signedUrl(row.s3Bucket, row.s3Key),
    kind: row.contentType.startsWith('video/') ? 'video' : 'image',
    durationSec: row.durationSec,
  };
}

export interface ResolvedBrandFonts {
  /** css font-family for Latin text (null = the EDL's default). */
  fontFamily: string | null;
  /** timeline.fonts sources. */
  fontSources: string[];
}

export function hostedFontUrl(baseUrl: string, family: string): string {
  return `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(family.replace(/ /g, ''))}.ttf`;
}

export interface ResolvedBrand {
  media: BrandMedia;
  fonts: ResolvedBrandFonts;
  aiLabel: boolean;
}

export async function resolveBrand(
  deps: { db: Db; storage: AssetStorage; fontsBaseUrl?: string },
  kit: BrandKit | null,
  language: string | null | undefined,
): Promise<ResolvedBrand> {
  const script = scriptOf(language);
  const scriptFont =
    script !== 'latin' && deps.fontsBaseUrl
      ? [hostedFontUrl(deps.fontsBaseUrl, fontFamilyFor(script, 700))]
      : [];
  if (!kit)
    return { media: {}, fonts: { fontFamily: null, fontSources: scriptFont }, aiLabel: false };
  const fontUpload = uploadedFontId(kit.fontPrimary);
  const ids = [
    kit.logoAssetId,
    kit.watermarkAssetId,
    kit.introCardAssetId,
    kit.outroCardAssetId,
    fontUpload,
  ].filter((id): id is string => Boolean(id));
  const rows = await readyUploads(deps.db, kit.organisationId, ids);
  const media: BrandMedia = {
    logo: await image(deps.storage, rows.get(kit.logoAssetId ?? ''), 'BRAND_LOGO'),
    watermark: await image(deps.storage, rows.get(kit.watermarkAssetId ?? ''), 'BRAND_WATERMARK'),
    intro: await card(deps.storage, rows.get(kit.introCardAssetId ?? '')),
    outro: await card(deps.storage, rows.get(kit.outroCardAssetId ?? '')),
  };

  let fonts: ResolvedBrandFonts = { fontFamily: null, fontSources: [] };
  const fontRow = fontUpload ? rows.get(fontUpload) : undefined;
  if (fontRow?.kind === 'BRAND_FONT' && fontRow.fontFamily && fontRow.licenceConfirmedAt) {
    fonts = {
      fontFamily: fontRow.fontFamily,
      fontSources: [await deps.storage.signedUrl(fontRow.s3Bucket, fontRow.s3Key)],
    };
  } else if (kit.fontPrimary && !fontUpload && SAFE_FONT.test(kit.fontPrimary)) {
    fonts = {
      fontFamily: kit.fontPrimary,
      fontSources: deps.fontsBaseUrl ? [hostedFontUrl(deps.fontsBaseUrl, kit.fontPrimary)] : [],
    };
  }
  if (script !== 'latin') fonts = { ...fonts, fontSources: [...fonts.fontSources, ...scriptFont] };
  return { media, fonts, aiLabel: kit.aiDisclosureLabel };
}

/** P2: is this organisation's output white-labelled? */
export async function resolveWhiteLabel(
  db: Pick<PrismaClient, 'orgPolicy'>,
  organisationId: string,
  planTier: PlanTier,
): Promise<boolean> {
  if (PLAN_CATALOGUE[planTier].whiteLabel) return true; // Phase 18 §P.1 (catalogue)
  const policy = await db.orgPolicy.findUnique({
    where: { organisationId },
    select: { whiteLabel: true },
  });
  return policy?.whiteLabel === true;
}

/**
 * P2: the platform end card for non-white-label outputs (STUDIO_MADE_WITH_CARD_URL, a public
 * image URL). Unset = no card: Studio adds no mark of its own unless the operator configures one.
 */
export function platformCardFromEnv(
  env: Record<string, string | undefined> = process.env,
): BrandCard | undefined {
  const url = env.STUDIO_MADE_WITH_CARD_URL?.trim();
  if (!url || !/^https:\/\//.test(url)) return undefined;
  return { src: url, kind: 'image' };
}
