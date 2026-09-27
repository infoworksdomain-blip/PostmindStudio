import type { PrismaClient, WebsiteScan } from '@prisma/client';
import type { PlanTier } from '../providers/router';

// BACKLOG 13.10 — Addendum A6.6 refresh cadence:
//   "Website scan: default every 30 days per business … Skipped if the site's ETag /
//    Last-Modified header shows no change."  "Stock library: weekly delta refresh."
// Two BullMQ job schedulers (scripts/worker.ts) drive it:
//   - sweep-website-rescans, daily at 03:30 UTC: every business whose last successful scan (or
//     last "unchanged" check) is ≥ 30 days old gets a rescan-website job, which first makes a
//     conditional request for the homepage and only starts a full scan when it changed;
//   - sweep-stock-refresh, Mondays 04:00 UTC: refresh-image-library for every business with a
//     profile (re-runs its stock queries; new images only, duplicates are skipped).

export const RESCAN_INTERVAL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
export const RESCAN_INTERVAL_MS = RESCAN_INTERVAL_DAYS * DAY_MS;
/** Rescans started per daily sweep (the rest are picked up the next day). */
export const MAX_RESCANS_PER_SWEEP = 200;
/** Businesses refreshed per weekly sweep. */
export const MAX_STOCK_REFRESHES_PER_SWEEP = 1_000;

/** Daily sweep time (UTC) — keep in step with RESCAN_SWEEP_PATTERN. */
export const RESCAN_SWEEP = { hour: 3, minute: 30 } as const;
export const RESCAN_SWEEP_PATTERN = `${RESCAN_SWEEP.minute} ${RESCAN_SWEEP.hour} * * *`;
/** Weekly stock refresh (UTC, day 1 = Monday) — keep in step with STOCK_REFRESH_PATTERN. */
export const STOCK_REFRESH = { weekday: 1, hour: 4, minute: 0 } as const;
export const STOCK_REFRESH_PATTERN = `${STOCK_REFRESH.minute} ${STOCK_REFRESH.hour} * * ${STOCK_REFRESH.weekday}`;

const PLAN_TIERS: readonly PlanTier[] = ['BASIC', 'STANDARD', 'PLUS', 'ENTERPRISE'];

export function scanPlanTier(value: string | null | undefined): PlanTier {
  return PLAN_TIERS.find((t) => t === value) ?? 'STANDARD';
}

/** First daily tick at or after `from`. */
export function nextDailyTick(from: number, at: { hour: number; minute: number } = RESCAN_SWEEP) {
  const d = new Date(from);
  const tick = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), at.hour, at.minute);
  return new Date(tick >= from ? tick : tick + DAY_MS);
}

/** First weekly tick at or after `from`. */
export function nextWeeklyTick(
  from: number,
  at: { weekday: number; hour: number; minute: number } = STOCK_REFRESH,
): Date {
  const d = new Date(from);
  const offset = (at.weekday - d.getUTCDay() + 7) % 7;
  const tick = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + offset,
    at.hour,
    at.minute,
  );
  return new Date(tick >= from ? tick : tick + 7 * DAY_MS);
}

/** When the last scan's content was last known to be current. */
export function freshAsOf(
  scan: Pick<WebsiteScan, 'completedAt' | 'checkedUnchangedAt'>,
): Date | null {
  const times = [scan.completedAt, scan.checkedUnchangedAt].filter((t): t is Date => t !== null);
  return times.length ? new Date(Math.max(...times.map((t) => t.getTime()))) : null;
}

export type ScanScheduleView = {
  nextScanAt: string | null;
  nextStockRefreshAt: string | null;
  lastSkippedUnchangedAt: string | null;
  lastScanAt: string | null;
  intervalDays: number;
};

/**
 * GET /businesses/:id/scans/schedule. A business is rescanned only after a successful scan, so
 * with none (or a scan in progress) there is no next scan time; the stock refresh needs a profile.
 */
export function scheduleView(input: {
  latest: Pick<WebsiteScan, 'state' | 'completedAt' | 'checkedUnchangedAt'> | null;
  lastSuccess: Pick<WebsiteScan, 'completedAt' | 'checkedUnchangedAt'> | null;
  hasProfile: boolean;
  now: number;
}): ScanScheduleView {
  const active = input.latest?.state === 'QUEUED' || input.latest?.state === 'RUNNING';
  const fresh = input.lastSuccess ? freshAsOf(input.lastSuccess) : null;
  const due = fresh ? Math.max(fresh.getTime() + RESCAN_INTERVAL_MS, input.now) : null;
  return {
    nextScanAt: due !== null && !active ? nextDailyTick(due).toISOString() : null,
    nextStockRefreshAt: input.hasProfile ? nextWeeklyTick(input.now).toISOString() : null,
    lastSkippedUnchangedAt: input.lastSuccess?.checkedUnchangedAt?.toISOString() ?? null,
    lastScanAt: input.lastSuccess?.completedAt?.toISOString() ?? null,
    intervalDays: RESCAN_INTERVAL_DAYS,
  };
}

export async function getScanSchedule(
  db: PrismaClient,
  scope: { organisationId: string; businessId: string },
  now: number,
): Promise<ScanScheduleView> {
  const [latest, lastSuccess, profile] = await Promise.all([
    db.websiteScan.findFirst({ where: scope, orderBy: { startedAt: 'desc' } }),
    db.websiteScan.findFirst({
      where: { ...scope, state: 'SUCCEEDED' },
      orderBy: { startedAt: 'desc' },
    }),
    db.businessProfile.findFirst({ where: scope, select: { imageSearchQueries: true } }),
  ]);
  return scheduleView({
    latest,
    lastSuccess,
    hasProfile: (profile?.imageSearchQueries.length ?? 0) > 0,
    now,
  });
}

export interface DueRescan {
  organisationId: string;
  businessId: string;
  scanId: string;
  planTier: PlanTier;
}

/**
 * Businesses whose newest scan SUCCEEDED and is ≥ 30 days fresh-as-of. A business whose newest
 * scan failed or is in progress is left alone (a person has to look at a failure).
 */
export async function findDueRescans(
  db: PrismaClient,
  now: number,
  limit = MAX_RESCANS_PER_SWEEP,
): Promise<DueRescan[]> {
  const cutoff = new Date(now - RESCAN_INTERVAL_MS);
  const rows = await db.$queryRaw<
    Array<{ id: string; organisationId: string; businessId: string; planTier: string | null }>
  >`
    SELECT latest.id, latest."organisationId", latest."businessId", latest."planTier"
    FROM (
      SELECT DISTINCT ON (s."organisationId", s."businessId") s.*
      FROM studio.website_scans s
      ORDER BY s."organisationId", s."businessId", s."startedAt" DESC
    ) latest
    WHERE latest.state = 'SUCCEEDED'
      AND GREATEST(latest."completedAt", COALESCE(latest."checkedUnchangedAt", latest."completedAt")) <= ${cutoff}
    ORDER BY latest."completedAt" ASC
    LIMIT ${limit}`;
  return rows.map((r) => ({
    organisationId: r.organisationId,
    businessId: r.businessId,
    scanId: r.id,
    planTier: scanPlanTier(r.planTier),
  }));
}

/** Businesses with stock queries, for the weekly refresh (tier from their newest scan). */
export async function findStockRefreshTargets(
  db: PrismaClient,
  limit = MAX_STOCK_REFRESHES_PER_SWEEP,
): Promise<Array<{ organisationId: string; businessId: string; planTier: PlanTier }>> {
  const rows = await db.$queryRaw<
    Array<{ organisationId: string; businessId: string; planTier: string | null }>
  >`
    SELECT p."organisationId", p."businessId", (
      SELECT s."planTier" FROM studio.website_scans s
      WHERE s."organisationId" = p."organisationId" AND s."businessId" = p."businessId"
      ORDER BY s."startedAt" DESC LIMIT 1
    ) AS "planTier"
    FROM studio.business_profiles p
    WHERE cardinality(p."imageSearchQueries") > 0
    ORDER BY p."organisationId", p."businessId"
    LIMIT ${limit}`;
  return rows.map((r) => ({
    organisationId: r.organisationId,
    businessId: r.businessId,
    planTier: scanPlanTier(r.planTier),
  }));
}
