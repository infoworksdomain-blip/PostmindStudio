import type { Prisma, PrismaClient, UploadKind } from '@prisma/client';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../../errors';
import type { TenantContext } from '../../tenant';
import { businessIdParam } from './businesses';
import { assertLinkableVoice } from './voice-profiles';
import { UPLOADED_FONT_PREFIX, uploadedFontId } from '../pipeline/brand-resolve';

// Spec 8.5 / 10 — brand kits: palette, fonts, tone, audience, CTA templates and restricted
// topics that Layers 1–2, the overlay presets (brand substitution) and composition read.
// One default kit per business (set-default is atomic).
// 15.B1: media fields (logo, watermark, intro/outro card) hold ids of READY brand uploads
// (POST /uploads kind brand_*); fontPrimary/fontSecondary may be "upload:<uploadId>" for an
// uploaded, licence-confirmed font. DELETE is a soft delete (spec 8.5).

type Db = PrismaClient;
const HEX = /^#[0-9a-fA-F]{6}$/;
const FONT = /^[A-Za-z0-9 -]{1,64}$/;
const UPLOADED_FONT = /^upload:[A-Za-z0-9_-]{1,64}$/;
const fontField = z
  .string()
  .trim()
  .refine((v) => FONT.test(v) || UPLOADED_FONT.test(v), 'invalid font name')
  .nullable();
const mediaId = z.string().trim().min(1).max(64).nullable();

const kitFields = z.object({
  name: z.string().trim().min(1).max(120),
  colourPalette: z.array(z.string().regex(HEX, 'colours must be #RRGGBB')).max(8),
  fontPrimary: fontField,
  fontSecondary: fontField,
  toneKeywords: z.array(z.string().trim().min(1).max(40)).max(10),
  audienceProfile: z.string().trim().max(1_000).nullable(),
  ctaTemplates: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(60),
        template: z.string().trim().min(1).max(200),
      }),
    )
    .max(10),
  restrictedTopics: z.array(z.string().trim().min(1).max(80)).max(30),
});

export const createBrandKitInput = kitFields.partial().extend({
  name: kitFields.shape.name,
  businessId: businessIdParam,
  isDefault: z.boolean().default(false),
});

export const updateBrandKitInput = kitFields
  .extend({
    /** 13.13: the brand voice (a READY voice profile of this organisation), or null for stock. */
    voiceProfileId: z.string().min(1).max(64).nullable(),
    /** 15.B1: READY brand uploads of the matching kind, or null to remove. */
    logoAssetId: mediaId,
    watermarkAssetId: mediaId,
    introCardAssetId: mediaId,
    outroCardAssetId: mediaId,
    /** Operator decision P6: small on-video "AI-generated" label (default off). */
    aiDisclosureLabel: z.boolean(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const listBrandKitsQuery = z.object({ businessId: businessIdParam.optional() });

export function listBrandKits(db: Db, organisationId: string, businessId?: string) {
  return db.brandKit.findMany({
    where: { organisationId, deletedAt: null, ...(businessId && { businessId }) },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
}

export async function getBrandKit(db: Db, organisationId: string, id: string) {
  const kit = await db.brandKit.findFirst({ where: { id, organisationId, deletedAt: null } });
  if (!kit) throw new NotFoundError('Brand kit not found');
  return kit;
}

const MEDIA_KINDS: Record<string, UploadKind> = {
  logoAssetId: 'BRAND_LOGO',
  watermarkAssetId: 'BRAND_WATERMARK',
  introCardAssetId: 'BRAND_CARD',
  outroCardAssetId: 'BRAND_CARD',
};

/** 15.B1: media and uploaded fonts must be READY brand uploads of this org and business. */
async function assertBrandUploads(
  db: Db,
  kit: { organisationId: string; businessId: string },
  input: z.infer<typeof updateBrandKitInput>,
): Promise<void> {
  const wanted: Array<{ field: string; id: string; kind: UploadKind }> = [];
  for (const [field, kind] of Object.entries(MEDIA_KINDS)) {
    const id = input[field as keyof typeof input];
    if (typeof id === 'string') wanted.push({ field, id, kind });
  }
  for (const field of ['fontPrimary', 'fontSecondary'] as const) {
    const id = uploadedFontId(input[field]);
    if (id) wanted.push({ field, id, kind: 'BRAND_FONT' });
  }
  if (wanted.length === 0) return;
  const rows = await db.videoUpload.findMany({
    where: { id: { in: wanted.map((w) => w.id) }, organisationId: kit.organisationId },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const w of wanted) {
    const row = byId.get(w.id);
    if (!row || row.kind !== w.kind)
      throw new ValidationError(`${w.field} is not a ${w.kind.toLowerCase()} upload`);
    if (row.state !== 'READY') throw new ValidationError(`${w.field}: the upload is not complete`);
    if (row.businessId && row.businessId !== kit.businessId)
      throw new ValidationError(`${w.field}: the upload belongs to another business`);
    if (w.kind === 'BRAND_FONT' && !row.licenceConfirmedAt)
      throw new ValidationError(`${w.field}: the font licence was not confirmed`);
  }
}

export { UPLOADED_FONT_PREFIX };

export async function createBrandKit(
  db: Db,
  tenant: TenantContext,
  input: z.infer<typeof createBrandKitInput>,
) {
  return db.$transaction(async (tx) => {
    const existing = await tx.brandKit.count({
      where: {
        organisationId: tenant.organisationId,
        businessId: input.businessId,
        deletedAt: null,
      },
    });
    // The first kit of a business is its default.
    const isDefault = input.isDefault || existing === 0;
    if (isDefault) {
      await tx.brandKit.updateMany({
        where: { organisationId: tenant.organisationId, businessId: input.businessId },
        data: { isDefault: false },
      });
    }
    return tx.brandKit.create({
      data: {
        organisationId: tenant.organisationId,
        businessId: input.businessId,
        name: input.name,
        isDefault,
        colourPalette: input.colourPalette ?? [],
        fontPrimary: input.fontPrimary ?? null,
        fontSecondary: input.fontSecondary ?? null,
        toneKeywords: input.toneKeywords ?? [],
        audienceProfile: input.audienceProfile ?? null,
        ctaTemplates: (input.ctaTemplates ?? []) as Prisma.InputJsonValue,
        restrictedTopics: input.restrictedTopics ?? [],
      },
    });
  });
}

export async function updateBrandKit(
  db: Db,
  organisationId: string,
  id: string,
  input: z.infer<typeof updateBrandKitInput>,
) {
  const kit = await getBrandKit(db, organisationId, id);
  if (input.voiceProfileId)
    await assertLinkableVoice(db, organisationId, kit.businessId, input.voiceProfileId);
  await assertBrandUploads(db, kit, input);
  return db.brandKit.update({
    where: { id },
    data: {
      ...input,
      ...(input.ctaTemplates && { ctaTemplates: input.ctaTemplates as Prisma.InputJsonValue }),
    },
  });
}

export async function setDefaultBrandKit(db: Db, organisationId: string, id: string) {
  return db.$transaction(async (tx) => {
    const kit = await tx.brandKit.findFirst({ where: { id, organisationId, deletedAt: null } });
    if (!kit) throw new NotFoundError('Brand kit not found');
    await tx.brandKit.updateMany({
      where: { organisationId, businessId: kit.businessId, id: { not: id } },
      data: { isDefault: false },
    });
    return tx.brandKit.update({ where: { id }, data: { isDefault: true } });
  });
}

/** Spec 8.5 "Soft-delete": the row stays (finished projects keep their kit), hidden from lists. */
export async function deleteBrandKit(
  db: Db,
  organisationId: string,
  id: string,
  now: Date = new Date(),
) {
  const kit = await getBrandKit(db, organisationId, id);
  const inUse = await db.videoProject.count({
    where: {
      organisationId,
      brandKitId: id,
      deletedAt: null,
      state: { notIn: ['PUBLISHED', 'REJECTED', 'FAILED'] },
    },
  });
  if (inUse > 0) throw new ValidationError(`Brand kit is used by ${inUse} active project(s)`);
  await db.brandKit.update({
    where: { id: kit.id },
    data: { deletedAt: now, isDefault: false },
  });
}
