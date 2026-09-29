import type { Prisma, PrismaClient } from '@prisma/client';

// Phase 18 §8 "Quota races": standalone enforces plan quotas, so the monthly count and the slot
// it reserves must not race. A transaction-scoped Postgres advisory lock per (organisation,
// month) serialises the check-and-reserve of concurrent generate calls across every web process;
// it is released when the transaction ends, so a crashed request cannot hold it.
// https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS (read 2026-09-29)

export const QUOTA_LOCK_TIMEOUT_MS = 15_000;
const QUOTA_LOCK_MAX_WAIT_MS = 5_000;

export function quotaLockKey(organisationId: string, month: string): string {
  return `studio-quota:${organisationId}:${month}`;
}

export async function withQuotaLock<T>(
  db: Pick<PrismaClient, '$transaction'>,
  organisationId: string,
  month: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(
    async (tx) => {
      const key = quotaLockKey(organisationId, month);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      return fn(tx);
    },
    { timeout: QUOTA_LOCK_TIMEOUT_MS, maxWait: QUOTA_LOCK_MAX_WAIT_MS },
  );
}
