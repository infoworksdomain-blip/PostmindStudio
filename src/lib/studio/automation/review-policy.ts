import type { Prisma, PrismaClient, QualityCheckState, ReviewPolicy } from '@prisma/client';
import type { QualityCheck } from '../pipeline/quality-checks';
import type { PlanTier } from '../providers/router';
import { SYSTEM_ACTOR_PREFIX } from './approval';

// Spec 5.9: "Human review checkpoint: default ON for first 10 videos of any new user, then
// per-org policy (auto-approve for trusted accounts, require review for enterprise)".
// DECISIONS (the spec does not define "trusted"):
//   - trusted = the project's creator already has ≥ N projects in this organisation that a
//     *person* approved (auto-approvals never count), N = STUDIO_AUTO_APPROVE_TRUST_THRESHOLD
//     (default 10, the spec's "first 10 videos");
//   - "require review for enterprise" = plan tier ENTERPRISE is never auto-approved;
//   - only a clean run is auto-approved: every render PASSED (not force-approved), no failed
//     check, content safety scanned and clean, and the pre-generation script-safety verdict
//     ALLOW (WARN / REVIEW always go to a person). Checks recorded as `not_run` (features not
//     built yet: watermark, caption sync, …) do not block — they are shown to a human reviewer
//     the same way and never claim to have passed.
//   - 20.21 (operator decision 2026-10-02, Hive removed): content safety recorded as `not_run`
//     ("Not scanned": no content-safety provider is configured) follows the project's review
//     policy like any other not-run check, so trusted creators and month plans keep auto-approval.
//     A flagged or failed scan, or no content-safety check at all, still goes to a person.

export const DEFAULT_TRUST_THRESHOLD = 10;
export const MAX_TRUST_THRESHOLD = 1_000;
export const TRUST_THRESHOLD_ENV = 'STUDIO_AUTO_APPROVE_TRUST_THRESHOLD';

export type ReviewReasonCode =
  | 'enterprise_plan'
  | 'config_invalid'
  | 'force_approved'
  | 'quality_not_clean'
  | 'content_safety_flag'
  | 'script_safety_flag'
  | 'not_trusted'
  | 'org_policy'
  | 'auto_approve_error';

export type ReviewDecision =
  | { decision: 'auto_approve' }
  | {
      decision: 'needs_review';
      code: ReviewReasonCode;
      /** English, for logs and older clients. */
      reason: string;
      /** 17.9: what the UI needs to say it in the reader's language (with `code`). */
      params?: Record<string, string | number>;
    };

export type ThresholdResult = { ok: true; value: number } | { ok: false; reason: string };

/** Parse the trust threshold. Invalid values never widen auto-approval: they disable it. */
export function trustThreshold(
  env: Record<string, string | undefined> = process.env,
): ThresholdResult {
  const raw = env[TRUST_THRESHOLD_ENV]?.trim();
  if (!raw) return { ok: true, value: DEFAULT_TRUST_THRESHOLD };
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TRUST_THRESHOLD)
    return {
      ok: false,
      reason: `${TRUST_THRESHOLD_ENV} must be an integer from 1 to ${MAX_TRUST_THRESHOLD}`,
    };
  return { ok: true, value };
}

export interface RenderForDecision {
  targetPlatform: string;
  qualityCheckState: QualityCheckState;
  qualityIssues: Prisma.JsonValue | null;
}

export interface AutoApprovalInput {
  planTier: PlanTier;
  threshold: ThresholdResult;
  humanApprovedCount: number;
  renders: RenderForDecision[];
  /** metadata.scriptSafety.verdict from planning; undefined = not recorded. */
  scriptSafetyVerdict: string | undefined;
  /** 13.18 organisation policy: false = never auto-approve. Absent = allowed. */
  orgAllowsAutoApprove?: boolean;
  /**
   * 20.9: the project belongs to a month plan whose owner chose "Generate and schedule" (their
   * approval of the plan, with its review window). Waives only the trusted-creator threshold;
   * every safety, quality, enterprise and organisation-policy check still applies.
   */
  ownerPreApproved?: boolean;
}

function checksOf(render: RenderForDecision): QualityCheck[] {
  return Array.isArray(render.qualityIssues)
    ? (render.qualityIssues as unknown as QualityCheck[])
    : [];
}

const review = (
  code: ReviewReasonCode,
  reason: string,
  params?: Record<string, string | number>,
): ReviewDecision => ({
  decision: 'needs_review',
  code,
  reason,
  ...(params && { params }),
});

function renderProblem(render: RenderForDecision): ReviewDecision | null {
  const checks = checksOf(render);
  const where = render.targetPlatform;
  if (
    render.qualityCheckState === 'FORCE_APPROVED' ||
    checks.some((c) => c.code === 'force_approved')
  )
    return review('force_approved', `Needs review: the ${where} variant was force-approved`, {
      platform: where,
    });
  const safety = checks.find((c) => c.code === 'content_safety');
  if (!safety || (safety.status !== 'passed' && safety.status !== 'not_run'))
    return review(
      'content_safety_flag',
      `Needs review: the ${where} variant's content-safety scan ${safety ? 'flagged it' : 'did not run'}`,
      { platform: where, outcome: safety ? 'flagged' : 'not_run' },
    );
  // 15.B2: a `warning` (brand-kit compliance, spec 13.1 "User review required") needs a person.
  if (
    render.qualityCheckState !== 'PASSED' ||
    checks.some((c) => c.status === 'failed' || c.status === 'warning')
  )
    return review(
      'quality_not_clean',
      `Needs review: a quality check on the ${where} variant did not pass`,
      { platform: where },
    );
  return null;
}

/** Pure decision for a READY_FOR_REVIEW project whose review policy is AUTO_APPROVE. */
export function decideAutoApproval(input: AutoApprovalInput): ReviewDecision {
  if (input.planTier === 'ENTERPRISE')
    return review('enterprise_plan', 'Needs review: enterprise organisations always review videos');
  if (input.orgAllowsAutoApprove === false)
    return review(
      'org_policy',
      'Needs review: your organisation’s policy turns automatic approval off',
    );
  if (!input.threshold.ok)
    return review(
      'config_invalid',
      `Needs review: automatic approval is misconfigured (${input.threshold.reason})`,
    );
  if (input.renders.length === 0)
    return review('quality_not_clean', 'Needs review: no rendered variants to check', {
      renders: 0,
    });
  for (const render of input.renders) {
    const problem = renderProblem(render);
    if (problem) return problem;
  }
  if (input.scriptSafetyVerdict !== 'ALLOW')
    return review(
      'script_safety_flag',
      input.scriptSafetyVerdict
        ? `Needs review: the script safety check returned ${input.scriptSafetyVerdict}`
        : 'Needs review: the script safety check result is missing',
    );
  const needed = input.threshold.value;
  if (input.humanApprovedCount < needed && !input.ownerPreApproved)
    return review(
      'not_trusted',
      `Needs review: first ${needed} videos — ${input.humanApprovedCount} of ${needed} approved by a person so far`,
      { approved: input.humanApprovedCount, needed },
    );
  return { decision: 'auto_approve' };
}

/**
 * Projects in this organisation, created by `userId`, that a person approved (an APPROVED
 * approval row not resolved by a system actor). The current project is excluded.
 */
export function countHumanApprovedProjects(
  db: Pick<PrismaClient, 'videoProject'>,
  input: { organisationId: string; userId: string; excludeProjectId: string },
): Promise<number> {
  return db.videoProject.count({
    where: {
      organisationId: input.organisationId,
      createdByUserId: input.userId,
      id: { not: input.excludeProjectId },
      approvals: {
        some: {
          state: 'APPROVED',
          resolvedByUserId: { not: null },
          NOT: { resolvedByUserId: { startsWith: SYSTEM_ACTOR_PREFIX } },
        },
      },
    },
  });
}

export function isAutoApprovePolicy(policy: ReviewPolicy): boolean {
  return policy === 'AUTO_APPROVE';
}
