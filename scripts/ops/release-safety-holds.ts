import { auditLog } from '../../src/lib/audit';
import { logger } from '../../src/lib/logger';
import { prisma } from '../../src/lib/prisma';
import { autoApproveIfTrusted } from '../../src/lib/studio/automation/auto-approve';
import {
  parseReleaseArgs,
  releaseSafetyHolds,
} from '../../src/lib/studio/ops/release-safety-holds';
import { createPipelineDeps } from '../../src/lib/studio/pipeline/create-deps';
import { createBullJobQueue } from '../../src/lib/studio/queue/enqueue';
import { redisConnectionFromEnv } from '../../src/lib/studio/queue/redis';

// BACKLOG 20.21 — one-off after removing Hive: release the projects 20.19 parked in
// QUALITY_CHECKING behind a Trust & Safety review only because no content-safety provider was
// available. Their content safety becomes "Not scanned" and the quality gate finishes (normal
// review, or auto-approval where the project's review policy allows it). Reviews with a real
// flag are left for staff. Logic and tests: src/lib/studio/ops/release-safety-holds.ts.
//
//   npx tsx scripts/ops/release-safety-holds.ts --dry-run     # list what would be released
//   npx tsx scripts/ops/release-safety-holds.ts               # release them
//   ... [--limit 500] [--org <organisationId>]
//
// On the server: scripts/vps/compose.sh production run --rm ops \
//   node --import tsx scripts/ops/release-safety-holds.ts --dry-run
// Needs the app env (DATABASE_URL; REDIS_URL for auto-approval's publish jobs). Safe to re-run.

async function main(): Promise<void> {
  const args = parseReleaseArgs(process.argv.slice(2));
  const queue = args.dryRun ? undefined : createBullJobQueue(redisConnectionFromEnv());
  try {
    const pipeline = queue ? createPipelineDeps({ db: prisma, queue }) : undefined;
    const report = await releaseSafetyHolds(
      {
        db: prisma,
        logger,
        audit: auditLog,
        now: Date.now,
        notifier: pipeline?.notifier,
        ...(pipeline && { afterReady: (job) => autoApproveIfTrusted(pipeline, job) }),
      },
      args,
    );
    logger.info(
      {
        ...report,
        releasable: report.releasable.length,
        released: report.released.length,
        releasableIds: report.releasable.slice(0, 50),
      },
      args.dryRun ? 'dry run: nothing released' : 'no-provider safety holds released',
    );
    if (report.skipped.length > 0) process.exitCode = 1;
  } finally {
    await queue?.close();
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, 'release-safety-holds failed');
  process.exitCode = 1;
});
