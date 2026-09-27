import { PrismaClient } from '@prisma/client';
import { logger } from '../src/lib/logger';
import { seedSystemFlags } from '../src/lib/studio/seed-system-flags';
import { seedSlideshowTemplates } from '../src/lib/studio/slideshow/seed-templates';

// BACKLOG 1.9 + 7.4. Idempotent and safe to re-run against a live database: existing flags are
// never overwritten, so a re-seed cannot silently switch off an active kill switch.

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const created = await seedSystemFlags(prisma);
    logger.info({ created }, '[seed] system_flags seeded');
    const templates = await seedSlideshowTemplates(prisma);
    logger.info({ created: templates }, '[seed] slideshow templates seeded');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, '[seed] failed');
  process.exitCode = 1;
});
