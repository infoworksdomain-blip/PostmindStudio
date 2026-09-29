import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AuditAction } from '../../audit-sink';
import { ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import { LOCALES } from '../../i18n/locales';
import type { TenantContext } from '../../tenant';
import type { BillingService } from '../billing/contracts';
import { getMembershipGateway } from './membership-gateway';
import { actorRole } from './members';
import { purgeOrganisation, type PurgeResult } from './organisation-purge';

// Phase 18 §3 /settings/organisation — name, logo, country and default locale; transfer of
// ownership; deletion (type the name to confirm). Deletion runs the same path as account
// deletion (§5.11): cancel the Stripe subscription, soft-delete the organisation and start the
// existing purge (30-day grace, then the hard-delete job). Audit rows are kept.

export const updateOrganisationInput = z
  .object({
    name: z.string().trim().min(2).max(80),
    logo: z.string().trim().url().max(2048).startsWith('https://').nullable(),
    country: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/)
      .nullable(),
    defaultLocale: z.enum(LOCALES).nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

/** §5.11 re-authentication: the caller's current password (absent for Google-only accounts). */
const reauthPassword = z.string().max(128).optional();

export const transferOwnershipInput = z
  .object({ memberId: z.string().min(1).max(128), password: reauthPassword })
  .strict();

export const deleteOrganisationInput = z
  .object({ confirmName: z.string().max(80), password: reauthPassword })
  .strict();

export interface OrganisationSettings {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  country: string | null;
  defaultLocale: string | null;
  createdAt: string;
  yourRole: string | null;
}

async function liveOrganisation(db: PrismaClient, organisationId: string) {
  const org = await db.organization.findFirst({ where: { id: organisationId, deletedAt: null } });
  if (!org) throw new NotFoundError('Organisation not found');
  return org;
}

export async function getOrganisationSettings(
  db: PrismaClient,
  tenant: TenantContext,
): Promise<OrganisationSettings> {
  const org = await liveOrganisation(db, tenant.organisationId);
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    logo: org.logo,
    country: org.country,
    defaultLocale: org.defaultLocale,
    createdAt: org.createdAt.toISOString(),
    yourRole: actorRole(tenant) ?? null,
  };
}

export async function updateOrganisationSettings(
  db: PrismaClient,
  tenant: TenantContext,
  input: z.infer<typeof updateOrganisationInput>,
  audit: (action: string, metadata: Record<string, unknown>) => void,
): Promise<OrganisationSettings> {
  const before = await liveOrganisation(db, tenant.organisationId);
  await db.organization.update({ where: { id: before.id }, data: input });
  const changed = Object.keys(input);
  // Ids and field names only: organisation names are not personal data, but keep metadata lean.
  audit(
    input.name !== undefined && input.name !== before.name ? AuditAction.OrgRenamed : 'org.updated',
    {
      fields: changed,
    },
  );
  return getOrganisationSettings(db, tenant);
}

/** Owner → another member becomes owner, the caller stays on as admin. */
export async function transferOwnership(
  db: PrismaClient,
  tenant: TenantContext,
  headers: Headers,
  memberId: string,
): Promise<void> {
  if (actorRole(tenant) !== 'owner')
    throw new ForbiddenError('Only an owner can transfer ownership', { reason: 'owner_only' });
  const target = await db.member.findFirst({
    where: { id: memberId, organizationId: tenant.organisationId },
  });
  if (!target) throw new NotFoundError('Member not found');
  if (target.userId === tenant.userId)
    throw new ValidationError('Choose another member to transfer ownership to');
  const self = await db.member.findFirst({
    where: { organizationId: tenant.organisationId, userId: tenant.userId },
  });
  if (!self) throw new NotFoundError('Your membership was not found');
  const gateway = getMembershipGateway();
  // Promote first, so the organisation always has an owner even if the second call fails.
  await gateway.updateMemberRole(headers, {
    organisationId: tenant.organisationId,
    memberId: target.id,
    role: 'owner',
  });
  await gateway.updateMemberRole(headers, {
    organisationId: tenant.organisationId,
    memberId: self.id,
    role: 'admin',
  });
}

export interface DeleteOrganisationDeps {
  db: PrismaClient;
  now: () => number;
  billing?: BillingService;
}

export async function deleteOrganisation(
  deps: DeleteOrganisationDeps,
  tenant: TenantContext,
  confirmName: string,
): Promise<PurgeResult> {
  const org = await liveOrganisation(deps.db, tenant.organisationId);
  if (confirmName.trim() !== org.name)
    throw new ValidationError('Type the organisation name exactly to confirm', {
      reason: 'name_mismatch',
    });
  // Stop billing first: a failure here must leave the organisation intact (retry is safe).
  await deps.billing?.cancelForDeletion(org.id);
  await deps.db.organization.update({
    where: { id: org.id },
    data: { deletedAt: new Date(deps.now()) },
  });
  return purgeOrganisation(deps, org.id);
}
