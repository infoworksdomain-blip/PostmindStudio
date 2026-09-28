import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { AuditEntry } from '../../audit';
import type { AssetStorage } from '../storage';
import {
  deleteObjects,
  hardDeleteBusiness,
  renderSidecarBuckets,
  unsharedAssetObjects,
  type ObjectRef,
} from './business-hard-delete';

// BACKLOG 15.E8 — spec 7.15 data retention, as a daily sweep (queue/workers/retention-sweep.ts)
// with a dry-run preview for staff (GET /api/studio/admin/retention). Rules (spec 7.15 table):
//   provider_jobs    "60 days full row, 12 months summary (org/provider/day rollup)": rows older
//                    than 60 days are deleted — the org/provider/day summary is provider_usage —
//   provider_usage   … and that summary is deleted after 12 months;
//   video_assets     "30-day grace after project delete": rows + S3 objects (an object another
//                    live project still references — 15.B6 reuse — is kept);
//   video_renders    "Keep as long as publication exists; else 90 days after project deletion":
//                    renders with ANY publication row are kept; others go with their S3 objects;
//   approval_tasks   "12 months after resolution";
//   data_exports     15.E1 export ZIPs expire 7 days after they are ready;
//   business_purges  15.E2 hard deletion once the 30-day grace has passed.
// Each rule handles at most RETENTION_BATCH rows per run, so a backlog drains over several days
// without long transactions. Objects are deleted before their rows (see business-hard-delete.ts).
// video_analytics retention runs in the analytics roll-up (11.2) and is not repeated here.

export const RETENTION_DAYS = {
  providerJobs: 60,
  assetsAfterProjectDelete: 30,
  rendersAfterProjectDelete: 90,
} as const;
export const RETENTION_MONTHS = { providerUsage: 12, approvalTasks: 12 } as const;
export const RETENTION_BATCH = 2_000;
/** Deleted projects handled per rule per run (their assets / renders). */
export const PROJECT_BATCH = 200;
export const BUSINESS_PURGES_PER_RUN = 20;

export const RETENTION_RULES = [
  'provider_jobs',
  'provider_usage',
  'video_assets',
  'video_renders',
  'approval_tasks',
  'data_exports',
  'business_purges',
] as const;
export type RetentionRule = (typeof RETENTION_RULES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

export function monthsBefore(now: number, months: number): Date {
  const d = new Date(now);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, d.getUTCDate(), d.getUTCHours()),
  );
}

export function retentionCutoffs(now: number): Record<RetentionRule, Date> {
  return {
    provider_jobs: new Date(now - RETENTION_DAYS.providerJobs * DAY_MS),
    provider_usage: monthsBefore(now, RETENTION_MONTHS.providerUsage),
    video_assets: new Date(now - RETENTION_DAYS.assetsAfterProjectDelete * DAY_MS),
    video_renders: new Date(now - RETENTION_DAYS.rendersAfterProjectDelete * DAY_MS),
    approval_tasks: monthsBefore(now, RETENTION_MONTHS.approvalTasks),
    data_exports: new Date(now),
    business_purges: new Date(now),
  };
}

export const RULE_DESCRIPTIONS: Record<RetentionRule, string> = {
  provider_jobs: 'Provider job rows older than 60 days (the daily summary stays in provider_usage)',
  provider_usage: 'Provider usage daily summaries older than 12 months',
  video_assets: 'Assets of projects deleted more than 30 days ago (and their files)',
  video_renders: 'Unpublished renders of projects deleted more than 90 days ago (and their files)',
  approval_tasks: 'Approval tasks resolved more than 12 months ago',
  data_exports: 'Data-export downloads past their 7-day link',
  business_purges: 'Businesses deleted by PostMind Core whose 30-day grace has passed',
};

type Db = PrismaClient;

/** Deleted projects (before the cutoff) that still have asset rows. */
async function projectsWithAssets(db: Db, before: Date, take: number): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ projectId: string }>>`
    SELECT DISTINCT a."projectId" FROM "studio"."video_assets" a
    JOIN "studio"."video_projects" p ON p."id" = a."projectId"
    WHERE p."deletedAt" < ${before}
    LIMIT ${take}`;
  return rows.map((r) => r.projectId);
}

/** Deleted projects (before the cutoff) that still have unpublished renders. */
async function projectsWithUnpublishedRenders(db: Db, before: Date, take: number) {
  const rows = await db.videoProject.findMany({
    where: { deletedAt: { lt: before }, renders: { some: { publications: { none: {} } } } },
    orderBy: { deletedAt: 'asc' },
    select: { id: true },
    take,
  });
  return rows.map((r) => r.id);
}

export interface RetentionPreviewRow {
  rule: RetentionRule;
  description: string;
  cutoff: string;
  /** Rows due now (for projects: counted over at most 5,000 deleted projects). */
  due: number;
}

/** Dry run: what each rule would delete now. Deletes nothing. */
export async function previewRetention(db: Db, now: number): Promise<RetentionPreviewRow[]> {
  const cut = retentionCutoffs(now);
  const assetProjects = await projectsWithAssets(db, cut.video_assets, 5_000);
  const renderProjects = await projectsWithUnpublishedRenders(db, cut.video_renders, 5_000);
  const due: Record<RetentionRule, number> = {
    provider_jobs: await db.providerJob.count({
      where: { startedAt: { lt: cut.provider_jobs }, state: { notIn: ['PENDING', 'RUNNING'] } },
    }),
    provider_usage: await db.providerUsage.count({ where: { day: { lt: cut.provider_usage } } }),
    video_assets: assetProjects.length
      ? await db.videoAsset.count({ where: { projectId: { in: assetProjects } } })
      : 0,
    video_renders: renderProjects.length
      ? await db.videoRender.count({
          where: { projectId: { in: renderProjects }, publications: { none: {} } },
        })
      : 0,
    approval_tasks: await db.approvalTask.count({
      where: { resolvedAt: { lt: cut.approval_tasks } },
    }),
    data_exports: await db.dataExport.count({
      where: { state: 'READY', expiresAt: { lt: cut.data_exports } },
    }),
    business_purges: await db.businessPurge.count({
      where: { state: 'soft_deleted', graceUntil: { lt: cut.business_purges } },
    }),
  };
  return RETENTION_RULES.map((rule) => ({
    rule,
    description: RULE_DESCRIPTIONS[rule],
    cutoff: cut[rule].toISOString(),
    due: due[rule],
  }));
}

export interface RetentionDeps {
  db: Db;
  storage: AssetStorage;
  logger: Logger;
  audit: (entry: AuditEntry) => void;
  now: () => number;
}

export type RetentionRunResult = Record<RetentionRule, { rows: number; objects: number }>;

async function sweepProviderJobs(db: Db, cutoff: Date) {
  const ids = (
    await db.providerJob.findMany({
      where: { startedAt: { lt: cutoff }, state: { notIn: ['PENDING', 'RUNNING'] } },
      orderBy: { startedAt: 'asc' },
      select: { id: true },
      take: RETENTION_BATCH,
    })
  ).map((r) => r.id);
  if (ids.length === 0) return 0;
  return (await db.providerJob.deleteMany({ where: { id: { in: ids } } })).count;
}

async function sweepProviderUsage(db: Db, cutoff: Date) {
  const ids = (
    await db.providerUsage.findMany({
      where: { day: { lt: cutoff } },
      select: { id: true },
      take: RETENTION_BATCH,
    })
  ).map((r) => r.id);
  if (ids.length === 0) return 0;
  return (await db.providerUsage.deleteMany({ where: { id: { in: ids } } })).count;
}

async function sweepAssets(deps: RetentionDeps, cutoff: Date) {
  const projectIds = await projectsWithAssets(deps.db, cutoff, PROJECT_BATCH);
  if (projectIds.length === 0) return { rows: 0, objects: 0 };
  const objects = await deleteObjects(
    deps.storage,
    await unsharedAssetObjects(deps.db, projectIds),
  );
  const rows = (await deps.db.videoAsset.deleteMany({ where: { projectId: { in: projectIds } } }))
    .count;
  return { rows, objects };
}

async function sweepRenders(deps: RetentionDeps, cutoff: Date) {
  const projectIds = await projectsWithUnpublishedRenders(deps.db, cutoff, PROJECT_BATCH);
  if (projectIds.length === 0) return { rows: 0, objects: 0 };
  const renders = await deps.db.videoRender.findMany({
    where: { projectId: { in: projectIds }, publications: { none: {} } },
    select: {
      id: true,
      s3Bucket: true,
      s3Key: true,
      thumbnailS3Key: true,
      captionsSrtS3Key: true,
    },
    take: RETENTION_BATCH,
  });
  if (renders.length === 0) return { rows: 0, objects: 0 };
  const refs: ObjectRef[] = renders.flatMap((r) => [
    { bucket: r.s3Bucket, key: r.s3Key },
    ...[r.thumbnailS3Key, r.captionsSrtS3Key]
      .filter((k): k is string => Boolean(k))
      .flatMap((key) => renderSidecarBuckets(r).map((bucket) => ({ bucket, key }))),
  ]);
  const objects = await deleteObjects(
    deps.storage,
    refs.filter((o) => o.bucket && o.key),
  );
  const ids = renders.map((r) => r.id);
  const rows = await deps.db.$transaction(async (tx) => {
    await tx.textOverlay.deleteMany({ where: { renderId: { in: ids } } });
    return (await tx.videoRender.deleteMany({ where: { id: { in: ids } } })).count;
  });
  return { rows, objects };
}

async function sweepApprovalTasks(db: Db, cutoff: Date) {
  const ids = (
    await db.approvalTask.findMany({
      where: { resolvedAt: { lt: cutoff } },
      select: { id: true },
      take: RETENTION_BATCH,
    })
  ).map((r) => r.id);
  if (ids.length === 0) return 0;
  return (await db.approvalTask.deleteMany({ where: { id: { in: ids } } })).count;
}

async function sweepExports(deps: RetentionDeps, now: Date) {
  const rows = await deps.db.dataExport.findMany({
    where: { state: 'READY', expiresAt: { lt: now } },
    take: RETENTION_BATCH,
  });
  let objects = 0;
  for (const row of rows) {
    if (row.s3Bucket && row.s3Key) {
      await deps.storage.delete(row.s3Bucket, row.s3Key);
      objects += 1;
    }
    await deps.db.dataExport.update({
      where: { id: row.id },
      data: { state: 'EXPIRED', s3Key: null },
    });
  }
  return { rows: rows.length, objects };
}

async function sweepBusinessPurges(deps: RetentionDeps, now: Date) {
  const due = await deps.db.businessPurge.findMany({
    where: { state: 'soft_deleted', graceUntil: { lt: now } },
    orderBy: { graceUntil: 'asc' },
    take: BUSINESS_PURGES_PER_RUN,
  });
  let rows = 0;
  let objects = 0;
  for (const purge of due) {
    const summary = await hardDeleteBusiness(deps, purge);
    await deps.db.businessPurge.update({
      where: { id: purge.id },
      data: { state: 'hard_deleted', hardDeletedAt: now, hardDeleteSummary: { ...summary } },
    });
    rows += Object.values(summary.rows).reduce((a, b) => a + b, 0);
    objects += summary.objects;
    deps.audit({
      actorUserId: 'system:studio-retention',
      organisationId: purge.organisationId,
      action: 'studio.business.hard_delete',
      resource: { type: 'business', id: purge.businessId },
      metadata: { projects: summary.projects, objects: summary.objects },
    });
  }
  return { rows, objects };
}

/** One daily sweep: every rule, bounded batches. */
export async function runRetentionSweep(deps: RetentionDeps): Promise<RetentionRunResult> {
  const now = deps.now();
  const cut = retentionCutoffs(now);
  const result: RetentionRunResult = {
    provider_jobs: { rows: await sweepProviderJobs(deps.db, cut.provider_jobs), objects: 0 },
    provider_usage: { rows: await sweepProviderUsage(deps.db, cut.provider_usage), objects: 0 },
    video_assets: await sweepAssets(deps, cut.video_assets),
    video_renders: await sweepRenders(deps, cut.video_renders),
    approval_tasks: { rows: await sweepApprovalTasks(deps.db, cut.approval_tasks), objects: 0 },
    data_exports: await sweepExports(deps, cut.data_exports),
    business_purges: await sweepBusinessPurges(deps, cut.business_purges),
  };
  deps.logger.info({ result }, 'retention sweep finished');
  return result;
}
