import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ConflictError } from '../../errors';

// Business ids come from PostMind Core, which exposes no endpoint to verify them (Phase 4 review
// list). Several Studio tables key by businessId alone (business_profiles.businessId is unique,
// image_library is unique per (businessId, fingerprint)), so a business id already used by
// another organisation must be refused — otherwise one tenant could read or overwrite another
// tenant's profile and library by guessing its id.

export const businessIdParam = z.string().trim().min(1).max(128);

export async function assertBusinessAvailable(
  db: PrismaClient,
  organisationId: string,
  businessId: string,
): Promise<void> {
  const where = { businessId, organisationId: { not: organisationId } };
  const [profile, image, scan] = await Promise.all([
    db.businessProfile.findFirst({ where, select: { id: true } }),
    db.imageLibraryItem.findFirst({ where, select: { id: true } }),
    db.websiteScan.findFirst({ where, select: { id: true } }),
  ]);
  if (profile || image || scan) {
    throw new ConflictError('This business id belongs to another organisation');
  }
}
