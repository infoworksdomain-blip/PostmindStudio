import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

// Phase 18 §2.8 — addresses Studio must not email: hard bounces and spam complaints (from the
// Resend webhook), and operator-added entries. Stored as the SHA-256 of the lowercased address,
// never the address itself, so a suppression outlives account deletion without keeping PII.

export type SuppressionReason = 'bounce' | 'complaint' | 'provider' | 'manual';

type Db = Pick<PrismaClient, 'emailSuppression'>;

export function normaliseAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function emailAddressHash(address: string): string {
  return createHash('sha256').update(normaliseAddress(address), 'utf8').digest('hex');
}

export async function isSuppressed(db: Db, address: string): Promise<boolean> {
  const row = await db.emailSuppression.findUnique({
    where: { addressHash: emailAddressHash(address) },
    select: { addressHash: true },
  });
  return row !== null;
}

/** Add an address (idempotent: the first reason recorded is kept). Returns true when new. */
export async function suppressAddress(
  db: Db,
  address: string,
  reason: SuppressionReason,
): Promise<boolean> {
  const { count } = await db.emailSuppression.createMany({
    data: [{ addressHash: emailAddressHash(address), reason }],
    skipDuplicates: true,
  });
  return count > 0;
}

/** Operator action (runbooks/email-resend.md): let a fixed address receive email again. */
export async function unsuppressAddress(db: Db, address: string): Promise<boolean> {
  const { count } = await db.emailSuppression.deleteMany({
    where: { addressHash: emailAddressHash(address) },
  });
  return count > 0;
}
