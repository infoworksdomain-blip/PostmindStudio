import { PrismaClient } from '@prisma/client';
import { logger } from '../src/lib/logger';
import { seedSystemFlags } from '../src/lib/studio/seed-system-flags';

// BACKLOG 1.9. Idempotent and safe to re-run against a live database: existing flags are
// never overwritten, so a re-seed cannot silently switch off an active kill switch.

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const created = await seedSystemFlags(prisma);
    logger.info({ created }, '[seed] system_flags seeded');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, '[seed] failed');
  process.exitCode = 1;
});
