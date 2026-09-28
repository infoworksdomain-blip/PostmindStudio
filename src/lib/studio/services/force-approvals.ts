import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

// BACKLOG 15.D5 / spec 13.5: "Every force-approve is audited and reviewable in the Admin Centre."
//
// GET /admin/force-approvals?days=30 lists renders whose quality gate a customer overrode
// (quality_check_state = FORCE_APPROVED), newest first, with the override note, the user, the
// checks that had failed, and the project and organisation. The audit event itself goes to
// PostMind's audit service (studio.render.force_approve); this view reads the render rows so
// staff can review without leaving Studio.
//
// When: forceApproveRender records { userId, note, at } on its `force_approved` check from 15.D5
// onwards. Earlier overrides only have "by <userId>: <note>" in the check's detail and no time,
// so they are dated by the render's creation (a render is force-approved while its run is still
// in review, normally within minutes of being created).

export const MAX_DAYS = 90;
export const MAX_ROWS = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

export const forceApprovalsQuery = z.object({
  days: z.coerce.number().int().min(1).max(MAX_DAYS).default(30),
  organisationId: z.string().trim().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_ROWS).default(100),
});

export type ForceApprovalsQuery = z.infer<typeof forceApprovalsQuery>;

interface StoredCheck {
  code?: unknown;
  status?: unknown;
  severity?: unknown;
  detail?: unknown;
  userId?: unknown;
  note?: unknown;
  at?: unknown;
}

export interface FailedCheck {
  code: string;
  severity: string;
  detail: string;
}

export interface ForceApproval {
  renderId: string;
  targetPlatform: string;
  aspectRatio: string;
  renderCreatedAt: string;
  approvedAt: string;
  /** false when approvedAt is the render's creation time (overrides before 15.D5). */
  approvedAtRecorded: boolean;
  approvedByUserId: string | null;
  note: string | null;
  failedChecks: FailedCheck[];
  /** name null: the user gave the project no name (17.9). */
  project: { id: string; name: string | null; state: string; businessId: string };
  organisationId: string;
}

const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Who and why, from the structured fields or the legacy "by <userId>: <note>" detail. */
export function parseOverride(check: StoredCheck | undefined): {
  userId: string | null;
  note: string | null;
  at: string | null;
} {
  if (!check) return { userId: null, note: null, at: null };
  const at = text(check.at);
  const validAt = at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : null;
  const userId = text(check.userId);
  const note = text(check.note);
  if (userId && note !== null) return { userId, note, at: validAt };
  const legacy = /^by (\S+): ([\s\S]*)$/.exec(text(check.detail) ?? '');
  return {
    userId: userId ?? legacy?.[1] ?? null,
    note: note ?? legacy?.[2] ?? null,
    at: validAt,
  };
}

export function failedChecksOf(checks: StoredCheck[]): FailedCheck[] {
  return checks
    .filter((c) => c.status === 'failed')
    .map((c) => ({
      code: text(c.code) ?? 'unknown',
      severity: text(c.severity) ?? 'error',
      detail: text(c.detail) ?? '',
    }));
}

export async function listForceApprovals(
  db: Pick<PrismaClient, 'videoRender'>,
  query: ForceApprovalsQuery,
  now: number,
): Promise<{ days: number; since: string; truncated: boolean; items: ForceApproval[] }> {
  const since = now - query.days * DAY_MS;
  // Candidates newest first, bounded; the window is applied to the approval time below.
  const rows = await db.videoRender.findMany({
    where: {
      qualityCheckState: 'FORCE_APPROVED',
      // Deleted projects stay listed: an override remains reviewable after the customer deletes.
      ...(query.organisationId && { project: { organisationId: query.organisationId } }),
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_ROWS,
    select: {
      id: true,
      targetPlatform: true,
      aspectRatio: true,
      createdAt: true,
      qualityIssues: true,
      project: {
        select: { id: true, name: true, state: true, businessId: true, organisationId: true },
      },
    },
  });
  const items = rows
    .map((row): ForceApproval => {
      const checks = Array.isArray(row.qualityIssues)
        ? (row.qualityIssues as StoredCheck[]).filter((c) => c && typeof c === 'object')
        : [];
      // The latest override wins (a render can only be force-approved once, but be defensive).
      const override = parseOverride(checks.filter((c) => c.code === 'force_approved').at(-1));
      return {
        renderId: row.id,
        targetPlatform: row.targetPlatform,
        aspectRatio: row.aspectRatio,
        renderCreatedAt: row.createdAt.toISOString(),
        approvedAt: override.at ?? row.createdAt.toISOString(),
        approvedAtRecorded: override.at !== null,
        approvedByUserId: override.userId,
        note: override.note,
        failedChecks: failedChecksOf(checks),
        project: {
          id: row.project.id,
          name: row.project.name,
          state: row.project.state,
          businessId: row.project.businessId,
        },
        organisationId: row.project.organisationId,
      };
    })
    .filter((item) => Date.parse(item.approvedAt) >= since)
    .sort((a, b) => b.approvedAt.localeCompare(a.approvedAt));
  return {
    days: query.days,
    since: new Date(since).toISOString(),
    truncated: rows.length === MAX_ROWS || items.length > query.limit,
    items: items.slice(0, query.limit),
  };
}
