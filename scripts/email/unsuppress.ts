import { PrismaClient } from '@prisma/client';
import { unsuppressAddress } from '../../src/lib/email/suppression';
import { logger } from '../../src/lib/logger';

// Phase 18 §2.8 (runbooks/email-resend.md, "Suppression"): let an address that bounced or
// complained receive Studio email again, after support confirmed the mailbox works.
//   npx tsx scripts/email/unsuppress.ts someone@example.com

async function main(): Promise<void> {
  const address = process.argv[2]?.trim();
  if (!address || !address.includes('@')) {
    logger.error('usage: npx tsx scripts/email/unsuppress.ts <address>');
    process.exitCode = 2;
    return;
  }
  const db = new PrismaClient();
  try {
    const removed = await unsuppressAddress(db, address);
    logger.info({ removed }, removed ? 'suppression removed' : 'address was not suppressed');
  } finally {
    await db.$disconnect();
  }
}

void main();
