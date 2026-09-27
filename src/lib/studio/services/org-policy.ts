import type { OrgPolicy, PrismaClient, ReviewPolicy } from '@prisma/client';
import { z } from 'zod';
import { ValidationError } from '../../errors';
import {
  MAX_TRUST_THRESHOLD,
  trustThreshold,
  type ThresholdResult,
} from '../automation/review-policy';

// BACKLOG 13.18 — per-organisation review policy, set by PostMind staff
// (GET|PUT /admin/organisations/:id/policy). Resolution: the organisation's row, else the
// platform default. It is consulted in two places:
//   - project creation: a project created without reviewPolicy gets defaultReviewPolicy
//     (a template's own policy and an explicit client value still win);
//   - auto-approve (automation/auto-approve.ts): autoApproveAllowed=false sends every video to a
//     person; autoApproveTrustThreshold replaces STUDIO_AUTO_APPROVE_TRUST_THRESHOLD for that
//     organisation. The other auto-approve rules (never ENTERPRISE, clean run only) still apply.

type Db = Pick<PrismaClient, 'orgPolicy'>;

export const REVIEW_POLICIES = [
  'AUTO_APPROVE',
  'REQUIRE_APPROVAL',
  'REQUIRE_APPROVAL_FROM_ROLE',
] as const;
/** Prisma's column default for video_projects.reviewPolicy. */
export const PLATFORM_DEFAULT_REVIEW_POLICY: ReviewPolicy = 'REQUIRE_APPROVAL';

export const organisationIdParam = z.string().trim().min(1).max(128);

export const orgPolicyInput = z
  .object({
    /** null = back to the platform default. */
    defaultReviewPolicy: z.enum(REVIEW_POLICIES).nullable().optional(),
    autoApproveAllowed: z.boolean().optional(),
    /** null = back to STUDIO_AUTO_APPROVE_TRUST_THRESHOLD. */
    autoApproveTrustThreshold: z
      .number()
      .int()
      .min(1)
      .max(MAX_TRUST_THRESHOLD)
      .nullable()
      .optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one policy field' });

export type OrgPolicyInput = z.infer<typeof orgPolicyInput>;

export interface EffectivePolicy {
  defaultReviewPolicy: ReviewPolicy;
  autoApproveTrustThreshold: number | null;
  autoApproveAllowed: boolean;
}

export interface OrgPolicyView {
  organisationId: string;
  policy: EffectivePolicy;
  /** Where each value comes from: the organisation's row, env or the platform default. */
  source: {
    defaultReviewPolicy: 'organisation' | 'default';
    autoApproveTrustThreshold: 'organisation' | 'env' | 'default' | 'invalid_env';
    autoApproveAllowed: 'organisation' | 'default';
  };
  updatedAt: Date | null;
  updatedByUserId: string | null;
}

function thresholdSource(row: OrgPolicy | null, env: ThresholdResult, envRaw: string | undefined) {
  if (row?.autoApproveTrustThreshold != null) return 'organisation' as const;
  if (!env.ok) return 'invalid_env' as const;
  return envRaw?.trim() ? ('env' as const) : ('default' as const);
}

export function viewPolicy(
  organisationId: string,
  row: OrgPolicy | null,
  env: Record<string, string | undefined> = process.env,
): OrgPolicyView {
  const envThreshold = trustThreshold(env);
  return {
    organisationId,
    policy: {
      defaultReviewPolicy: row?.defaultReviewPolicy ?? PLATFORM_DEFAULT_REVIEW_POLICY,
      autoApproveTrustThreshold:
        row?.autoApproveTrustThreshold ?? (envThreshold.ok ? envThreshold.value : null),
      autoApproveAllowed: row?.autoApproveAllowed ?? true,
    },
    source: {
      defaultReviewPolicy: row?.defaultReviewPolicy ? 'organisation' : 'default',
      autoApproveTrustThreshold: thresholdSource(
        row,
        envThreshold,
        env.STUDIO_AUTO_APPROVE_TRUST_THRESHOLD,
      ),
      autoApproveAllowed: row ? 'organisation' : 'default',
    },
    updatedAt: row?.updatedAt ?? null,
    updatedByUserId: row?.updatedByUserId ?? null,
  };
}

export function findOrgPolicy(db: Db, organisationId: string): Promise<OrgPolicy | null> {
  return db.orgPolicy.findUnique({ where: { organisationId } });
}

export async function getOrgPolicy(db: Db, organisationId: string): Promise<OrgPolicyView> {
  const id = organisationIdParam.safeParse(organisationId);
  if (!id.success) throw new ValidationError('Invalid organisation id');
  return viewPolicy(id.data, await findOrgPolicy(db, id.data));
}

export async function putOrgPolicy(
  db: Db,
  organisationId: string,
  input: OrgPolicyInput,
  actorUserId: string,
): Promise<{ before: OrgPolicyView; after: OrgPolicyView }> {
  const id = organisationIdParam.safeParse(organisationId);
  if (!id.success) throw new ValidationError('Invalid organisation id');
  const existing = await findOrgPolicy(db, id.data);
  const fields = {
    ...(input.defaultReviewPolicy !== undefined && {
      defaultReviewPolicy: input.defaultReviewPolicy,
    }),
    ...(input.autoApproveAllowed !== undefined && {
      autoApproveAllowed: input.autoApproveAllowed,
    }),
    ...(input.autoApproveTrustThreshold !== undefined && {
      autoApproveTrustThreshold: input.autoApproveTrustThreshold,
    }),
    updatedByUserId: actorUserId,
  };
  const row = await db.orgPolicy.upsert({
    where: { organisationId: id.data },
    create: { organisationId: id.data, ...fields },
    update: fields,
  });
  return { before: viewPolicy(id.data, existing), after: viewPolicy(id.data, row) };
}

/** The review policy a new project gets when the client sends none (13.18). */
export async function defaultReviewPolicyFor(
  db: Db,
  organisationId: string,
): Promise<ReviewPolicy | undefined> {
  return (await findOrgPolicy(db, organisationId))?.defaultReviewPolicy ?? undefined;
}

/** What auto-approve needs from the organisation's policy (13.18). */
export async function autoApprovePolicyFor(
  db: Db,
  organisationId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{ allowed: boolean; threshold: ThresholdResult }> {
  const row = await findOrgPolicy(db, organisationId);
  return {
    allowed: row?.autoApproveAllowed ?? true,
    threshold:
      row?.autoApproveTrustThreshold != null
        ? { ok: true, value: row.autoApproveTrustThreshold }
        : trustThreshold(env),
  };
}
