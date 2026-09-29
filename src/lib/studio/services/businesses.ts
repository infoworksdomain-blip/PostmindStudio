import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, NotFoundError, QuotaExceededError, ValidationError } from '../../errors';
import type { EntitlementsReader } from '../billing/entitlements-reader';

// Business ids. In core mode they come from PostMind Core, which exposes no endpoint to verify
// them (Phase 4 review list), so every Feature D table is keyed by (organisationId, businessId):
// two tenants using the same id get two independent profiles and libraries, and neither can read,
// overwrite or block the other's.
//
// Phase 18 §2.11 (standalone): the organisation's businesses live in studio.businesses. The CRUD
// below backs GET/POST /businesses and PATCH/DELETE /businesses/:id, and assertBusinessInOrg is
// the check the route wrapper runs on every write that names a businessId (api/business-guard.ts).

export const businessIdParam = z.string().trim().min(1).max(128);

/** Business id from a path or form field; malformed ids are 400s. */
export function parseBusinessId(value: unknown): string {
  const parsed = businessIdParam.safeParse(value);
  if (!parsed.success) throw new ValidationError('businessId must be 1-128 characters');
  return parsed.data;
}

// A bare host name ("leedssourdough.co.uk"): no scheme, path or port. Stored lower-case.
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const businessName = z.string().trim().min(1).max(120);
const businessDomain = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => v.replace(/^https?:\/\//, '').replace(/\/+$/, ''))
  .pipe(z.string().regex(HOSTNAME, 'domain must be a host name such as example.co.uk'));

export const createBusinessInput = z
  .object({ name: businessName, domain: businessDomain.optional() })
  .strict();

export const updateBusinessInput = z
  .object({ name: businessName.optional(), domain: businessDomain.nullable().optional() })
  .strict()
  .refine((v) => v.name !== undefined || v.domain !== undefined, {
    message: 'Nothing to update: send name and/or domain',
  });

export type CreateBusinessInput = z.infer<typeof createBusinessInput>;
export type UpdateBusinessInput = z.infer<typeof updateBusinessInput>;

export interface BusinessView {
  id: string;
  name: string;
  domain: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const VIEW = { id: true, name: true, domain: true, createdAt: true, updatedAt: true } as const;

type Db = Pick<PrismaClient, 'business' | '$transaction'>;

/** Live (not deleted) businesses of the organisation, oldest first (the first is the default). */
export function listBusinesses(db: Pick<PrismaClient, 'business'>, organisationId: string) {
  return db.business.findMany({
    where: { organisationId, deletedAt: null },
    select: VIEW,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

/**
 * 404 unless `businessId` is a live business of `organisationId`. A business of another
 * organisation is indistinguishable from a missing one (no cross-tenant existence oracle).
 */
export async function assertBusinessInOrg(
  db: Pick<PrismaClient, 'business'>,
  organisationId: string,
  businessId: string,
): Promise<void> {
  const found = await db.business.findFirst({
    where: { id: businessId, organisationId, deletedAt: null },
    select: { id: true },
  });
  if (!found) throw new NotFoundError('Business not found');
}

// The partial unique index businesses_org_lower_name_live_key (migration 20261004010000) holds
// (organisationId, lower(name)) among live rows; a clash surfaces as P2002.
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

const nameTaken = () => new ConflictError('A business with this name already exists');

export async function createBusiness(
  deps: { db: Db; entitlements?: EntitlementsReader },
  actor: { organisationId: string; userId: string },
  input: CreateBusinessInput,
): Promise<BusinessView> {
  const limit = deps.entitlements
    ? (await deps.entitlements.forOrganisation(actor.organisationId)).limits.businesses
    : null;
  try {
    return await deps.db.$transaction(async (tx) => {
      // Serialise creates per organisation so two parallel requests cannot both pass the limit.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`studio:businesses:${actor.organisationId}`}, 0))`;
      if (limit !== null) {
        const count = await tx.business.count({
          where: { organisationId: actor.organisationId, deletedAt: null },
        });
        if (count >= limit)
          throw new QuotaExceededError(`Your plan includes ${limit} business(es)`, {
            resource: 'businesses',
            limit,
          });
      }
      return tx.business.create({
        data: {
          organisationId: actor.organisationId,
          name: input.name,
          domain: input.domain ?? null,
          createdByUserId: actor.userId,
        },
        select: VIEW,
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw nameTaken();
    throw err;
  }
}

export async function updateBusiness(
  db: Pick<PrismaClient, 'business'>,
  organisationId: string,
  businessId: string,
  input: UpdateBusinessInput,
): Promise<BusinessView> {
  await assertBusinessInOrg(db, organisationId, businessId);
  try {
    return await db.business.update({
      where: { id: businessId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.domain !== undefined && { domain: input.domain }),
      },
      select: VIEW,
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw nameTaken();
    throw err;
  }
}

/** Soft delete (the purge's 30-day grace applies to its data; business-purge.ts). */
export async function markBusinessDeleted(
  db: Pick<PrismaClient, 'business'>,
  organisationId: string,
  businessId: string,
  now: Date,
): Promise<void> {
  const updated = await db.business.updateMany({
    where: { id: businessId, organisationId, deletedAt: null },
    data: { deletedAt: now },
  });
  if (updated.count === 0) throw new NotFoundError('Business not found');
}
