import type { PrismaClient, SafetyAuditItem } from '@prisma/client';
import type { Logger } from 'pino';
import { z } from 'zod';
import { ConfigurationError, ConflictError, NotFoundError, ValidationError } from '../../errors';
import type { Notifier } from '../notifications/notifier';
import type { AssetStorage } from '../storage';

// BACKLOG 14.11 — Trust & Safety monthly audit (runbooks/content-safety-miss.md). Every month a
// scheduled job draws a random sample of N videos published the month before
// (STUDIO_SAFETY_AUDIT_SAMPLE, default 50) into studio.safety_audit_items. Staff re-check each
// one on Admin → Safety audit and record pass or miss (a miss: the published video should have
// been blocked or sent to review, i.e. the Hive scan missed it). A miss notifies staff at once.
// The period's misses / reviewed is the runbook metric "Hive scan miss rate".

export const SAFETY_AUDIT_SAMPLE_DEFAULT = 50;
export const SAFETY_AUDIT_SAMPLE_MAX = 500;
/** 06:00 UTC on the 1st: samples the month that just ended. */
export const SAFETY_AUDIT_SCHEDULE = '0 6 1 * *';
export const AUDIT_RESULTS = ['pending', 'pass', 'miss'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
export const periodParam = z.string().regex(PERIOD, 'period must be YYYY-MM');

export function safetyAuditSampleFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.STUDIO_SAFETY_AUDIT_SAMPLE?.trim();
  if (!raw) return SAFETY_AUDIT_SAMPLE_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > SAFETY_AUDIT_SAMPLE_MAX)
    throw new ConfigurationError(
      `STUDIO_SAFETY_AUDIT_SAMPLE must be an integer from 1 to ${SAFETY_AUDIT_SAMPLE_MAX}`,
    );
  return n;
}

/** 'YYYY-MM' (UTC) of the month before `now`. */
export function previousPeriod(now: number): string {
  const d = new Date(now);
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** [start, end) of a 'YYYY-MM' period in UTC. */
export function periodRange(period: string): { start: Date; end: Date } {
  if (!PERIOD.test(period)) throw new ValidationError('period must be YYYY-MM');
  const [year, month] = period.split('-').map(Number) as [number, number];
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)),
  };
}

type AuditDb = Pick<PrismaClient, 'safetyAuditItem' | 'videoPublication' | 'videoRender'> &
  Pick<PrismaClient, '$queryRaw'>;

export interface SampleResult {
  period: string;
  requested: number;
  /** Rows added by this call (0 when the period already had its sample). */
  added: number;
  /** Rows the period holds now. */
  total: number;
  /** Published videos in the period (the population sampled from). */
  population: number;
}

/**
 * Draw (or top up) the period's sample. Idempotent: a period already holding `sampleSize` rows
 * gets nothing new; a smaller one is topped up with publications not yet sampled.
 */
export async function sampleSafetyAudit(
  db: AuditDb,
  input: { period: string; sampleSize: number },
): Promise<SampleResult> {
  const { start, end } = periodRange(input.period);
  const [existing, population] = await Promise.all([
    db.safetyAuditItem.count({ where: { period: input.period } }),
    db.videoPublication.count({
      where: { state: 'PUBLISHED', publishedAt: { gte: start, lt: end } },
    }),
  ]);
  const wanted = Math.max(0, input.sampleSize - existing);
  if (wanted === 0 || population === 0)
    return {
      period: input.period,
      requested: input.sampleSize,
      added: 0,
      total: existing,
      population,
    };

  // Uniform random sample in Postgres; parameters are bound (tagged template), never spliced.
  const picked = await db.$queryRaw<Array<{ id: string }>>`
    SELECT p.id FROM studio.video_publications p
    WHERE p.state = 'PUBLISHED' AND p."publishedAt" >= ${start} AND p."publishedAt" < ${end}
      AND NOT EXISTS (
        SELECT 1 FROM studio.safety_audit_items a
        WHERE a.period = ${input.period} AND a."publicationId" = p.id
      )
    ORDER BY random() LIMIT ${wanted}`;
  const publications = picked.length
    ? await db.videoPublication.findMany({
        where: { id: { in: picked.map((p) => p.id) } },
        select: {
          id: true,
          organisationId: true,
          projectId: true,
          platform: true,
          platformUrl: true,
          publishedAt: true,
        },
      })
    : [];
  const created = await db.safetyAuditItem.createMany({
    data: publications.map((p) => ({
      period: input.period,
      organisationId: p.organisationId,
      publicationId: p.id,
      projectId: p.projectId,
      platform: p.platform,
      platformUrl: p.platformUrl,
      publishedAt: p.publishedAt ?? start,
    })),
    skipDuplicates: true,
  });
  return {
    period: input.period,
    requested: input.sampleSize,
    added: created.count,
    total: existing + created.count,
    population,
  };
}

export interface AuditSummary {
  period: string;
  sampled: number;
  pending: number;
  passed: number;
  missed: number;
  /** "Hive scan miss rate": missed / (passed + missed); null until something is reviewed. */
  missRate: number | null;
}

export async function auditSummary(db: AuditDb, period: string): Promise<AuditSummary> {
  const groups = await db.safetyAuditItem.groupBy({
    by: ['result'],
    where: { period },
    _count: { _all: true },
  });
  const n = (r: AuditResult) => groups.find((g) => g.result === r)?._count._all ?? 0;
  const passed = n('pass');
  const missed = n('miss');
  const reviewed = passed + missed;
  return {
    period,
    sampled: passed + missed + n('pending'),
    pending: n('pending'),
    passed,
    missed,
    missRate: reviewed === 0 ? null : Math.round((missed / reviewed) * 1000) / 1000,
  };
}

export const listSafetyAuditQuery = z.object({
  period: periodParam.optional(),
  result: z.enum(AUDIT_RESULTS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(64).optional(),
});

export type ListSafetyAuditQuery = z.infer<typeof listSafetyAuditQuery>;

function viewItem(row: SafetyAuditItem, previewUrl: string | null) {
  return {
    id: row.id,
    period: row.period,
    organisationId: row.organisationId,
    publicationId: row.publicationId,
    projectId: row.projectId,
    platform: row.platform,
    platformUrl: row.platformUrl,
    publishedAt: row.publishedAt.toISOString(),
    result: row.result as AuditResult,
    note: row.note,
    reviewedByUserId: row.reviewedByUserId,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    previewUrl,
  };
}

async function previewFor(
  deps: { db: AuditDb; storage: AssetStorage },
  publicationId: string,
): Promise<string | null> {
  const publication = await deps.db.videoPublication.findUnique({
    where: { id: publicationId },
    select: { renderId: true },
  });
  if (!publication) return null;
  const render = await deps.db.videoRender.findUnique({
    where: { id: publication.renderId },
    select: { s3Bucket: true, s3Key: true },
  });
  return render ? deps.storage.signedUrl(render.s3Bucket, render.s3Key) : null;
}

/** The period's items (default: last month) with a signed preview of each render. */
export async function listSafetyAudit(
  deps: { db: AuditDb; storage: AssetStorage; now: () => number },
  query: ListSafetyAuditQuery,
) {
  const period = query.period ?? previousPeriod(deps.now());
  const rows = await deps.db.safetyAuditItem.findMany({
    where: { period, ...(query.result && { result: query.result }) },
    orderBy: [{ publishedAt: 'asc' }, { id: 'asc' }],
    take: query.limit + 1,
    ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
  });
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const data = await Promise.all(
    page.map(async (row) => viewItem(row, await previewFor(deps, row.publicationId))),
  );
  const periods = await deps.db.safetyAuditItem.findMany({
    distinct: ['period'],
    select: { period: true },
    orderBy: { period: 'desc' },
    take: 24,
  });
  return {
    summary: await auditSummary(deps.db, period),
    periods: periods.map((p) => p.period),
    data,
    hasMore,
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
  };
}

export const auditResultInput = z
  .object({
    result: z.enum(['pass', 'miss']),
    note: z.string().trim().max(1_000).optional(),
  })
  .strict()
  .refine((v) => v.result === 'pass' || (v.note?.length ?? 0) >= 3, {
    message: 'a miss needs a note (at least 3 characters) saying what was missed',
    path: ['note'],
  });

export type AuditResultInput = z.infer<typeof auditResultInput>;

/**
 * Record a staff verdict. A result is recorded once (409 afterwards): the audit trail is the
 * record. A miss notifies PostMind staff (runbooks/content-safety-miss.md).
 */
export async function recordAuditResult(
  deps: { db: AuditDb; notifier: Notifier; logger: Pick<Logger, 'error'>; now: () => number },
  id: string,
  input: AuditResultInput,
  actorUserId: string,
) {
  const updated = await deps.db.safetyAuditItem.updateMany({
    where: { id, result: 'pending' },
    data: {
      result: input.result,
      note: input.note ?? null,
      reviewedByUserId: actorUserId,
      reviewedAt: new Date(deps.now()),
    },
  });
  const row = await deps.db.safetyAuditItem.findUnique({ where: { id } });
  if (!row) throw new NotFoundError('Audit item not found');
  if (updated.count === 0) throw new ConflictError(`Already recorded as ${row.result}`);
  if (row.result === 'miss') {
    try {
      await deps.notifier.notifyStaff({
        kind: 'safety_review',
        title: 'Trust & Safety audit: Hive scan miss',
        body: `A published ${row.platform} video (organisation ${row.organisationId}, publication ${row.publicationId}) failed the ${row.period} audit: ${row.note ?? ''}. Follow runbooks/content-safety-miss.md.`,
        link: '/admin?tab=safety-audit',
        dedupeKey: `safety-audit-miss:${row.id}`,
      });
    } catch (err) {
      // The verdict is stored and audited; a failed staff notification must not undo it.
      deps.logger.error({ err, auditItemId: row.id }, 'safety audit miss notification failed');
    }
  }
  return viewItem(row, null);
}
