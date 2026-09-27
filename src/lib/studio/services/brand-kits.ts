import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../../errors';
import type { TenantContext } from '../../tenant';
import { businessIdParam } from './businesses';

// Spec 8.5 / 10 — brand kits: palette, fonts, tone, audience, CTA templates and restricted
// topics that Layers 1–2, the overlay presets (brand substitution) and composition read.
// One default kit per business (set-default is atomic).

type Db = PrismaClient;
const HEX = /^#[0-9a-fA-F]{6}$/;
const FONT = /^[A-Za-z0-9 -]{1,64}$/;

const kitFields = z.object({
  name: z.string().trim().min(1).max(120),
  colourPalette: z.array(z.string().regex(HEX, 'colours must be #RRGGBB')).max(8),
  fontPrimary: z.string().trim().regex(FONT, 'invalid font name').nullable(),
  fontSecondary: z.string().trim().regex(FONT, 'invalid font name').nullable(),
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
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const listBrandKitsQuery = z.object({ businessId: businessIdParam.optional() });

export function listBrandKits(db: Db, organisationId: string, businessId?: string) {
  return db.brandKit.findMany({
    where: { organisationId, ...(businessId && { businessId }) },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
}

export async function getBrandKit(db: Db, organisationId: string, id: string) {
  const kit = await db.brandKit.findFirst({ where: { id, organisationId } });
  if (!kit) throw new NotFoundError('Brand kit not found');
  return kit;
}

export async function createBrandKit(
  db: Db,
  tenant: TenantContext,
  input: z.infer<typeof createBrandKitInput>,
) {
  return db.$transaction(async (tx) => {
    const existing = await tx.brandKit.count({
      where: { organisationId: tenant.organisationId, businessId: input.businessId },
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
  await getBrandKit(db, organisationId, id);
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
    const kit = await tx.brandKit.findFirst({ where: { id, organisationId } });
    if (!kit) throw new NotFoundError('Brand kit not found');
    await tx.brandKit.updateMany({
      where: { organisationId, businessId: kit.businessId, id: { not: id } },
      data: { isDefault: false },
    });
    return tx.brandKit.update({ where: { id }, data: { isDefault: true } });
  });
}

export async function deleteBrandKit(db: Db, organisationId: string, id: string) {
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
  await db.brandKit.delete({ where: { id: kit.id } });
}
