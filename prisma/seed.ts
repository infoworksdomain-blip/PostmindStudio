import { PrismaClient } from '@prisma/client';
import { logger } from '../src/lib/logger';
import { seedSystemFlags } from '../src/lib/studio/seed-system-flags';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { seedTaxonomy } from '../src/lib/studio/library/taxonomy';
import { bumpLibraryVersionOnce, createOneOffRedisClient } from '../src/lib/studio/library/cache';
import { redisConnectionFromEnv } from '../src/lib/studio/queue/redis';
import { seedOverlayPresets } from '../src/lib/studio/overlays/seed-presets';
import { seedSlideshowTemplates } from '../src/lib/studio/slideshow/seed-templates';
import { seedProjectTemplates } from '../src/lib/studio/templates/seed';

// BACKLOG 1.9 + 7.4 + 8.2 + 9.7. Idempotent and safe to re-run against a live database: existing flags are
// never overwritten, so a re-seed cannot silently switch off an active kill switch.

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const created = await seedSystemFlags(prisma);
    logger.info({ created }, '[seed] system_flags seeded');
    const templates = await seedSlideshowTemplates(prisma);
    logger.info({ created: templates }, '[seed] slideshow templates seeded');
    const projectTemplates = await seedProjectTemplates(prisma);
    logger.info({ created: projectTemplates }, '[seed] project templates seeded');
    const presets = await seedOverlayPresets(prisma);
    logger.info({ created: presets }, '[seed] overlay presets seeded');
    const taxonomy = await seedTaxonomy(
      prisma,
      JSON.parse(readFileSync(join(__dirname, 'data', 'library-taxonomy.json'), 'utf8')) as unknown,
    );
    logger.info(taxonomy, '[seed] library categories seeded');
    // 20.15: category names / tree may have changed: cached library reads must see them.
    await bumpLibraryVersionOnce('taxonomy-seed', {
      connect: () => createOneOffRedisClient(redisConnectionFromEnv()),
    });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, '[seed] failed');
  process.exitCode = 1;
});
