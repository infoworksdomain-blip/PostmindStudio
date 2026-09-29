import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';

// Phase 18 §2.6 — studio.audit_log keeps entries for STUDIO_AUDIT_RETENTION_DAYS (default 730,
// 2 years). The table is append-only: its trigger refuses DELETE unless the transaction opted in
// with SET LOCAL studio.audit_retention = 'on', which only this job does.

export const AUDIT_RETENTION_SCHEDULE = '15 2 * * *'; // 02:15 UTC daily
export const DEFAULT_AUDIT_RETENTION_DAYS = 730;
const MIN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export function auditRetentionDays(
  env: Record<string, string | undefined> = process.env,
  log?: Pick<Logger, 'warn'>,
): number {
  const raw = env.STUDIO_AUDIT_RETENTION_DAYS?.trim();
  if (!raw) return DEFAULT_AUDIT_RETENTION_DAYS;
  const days = Number(raw);
  if (Number.isInteger(days) && days >= MIN_DAYS) return days;
  log?.warn({ value: raw }, '[audit-retention] invalid STUDIO_AUDIT_RETENTION_DAYS; using 730');
  return DEFAULT_AUDIT_RETENTION_DAYS;
}

/** Delete entries older than `days`; returns how many went. */
export async function purgeExpiredAuditEntries(
  db: Pick<PrismaClient, '$transaction'>,
  options: { now: number; days: number },
): Promise<number> {
  const cutoff = new Date(options.now - options.days * DAY_MS);
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL studio.audit_retention = 'on'`);
    const { count } = await tx.auditLog.deleteMany({ where: { occurredAt: { lt: cutoff } } });
    return count;
  });
}
