import { logger } from '../../src/lib/logger';
import { prisma } from '../../src/lib/prisma';
import {
  effectiveConcurrency,
  parseRebuildPreviewsArgs,
  prismaPreviewItems,
  rebuildLibraryPreviews,
} from '../../src/lib/studio/ops/rebuild-previews';
import { createFfmpegInspector } from '../../src/lib/studio/pipeline/media-probe';
import { getAssetStorage } from '../../src/lib/studio/storage';

// BACKLOG 20.17 — one-off: regenerate the preview rendition of every live reference-library item
// so it has sound (operator decision 2026-10-01; previews were muted until then). For each
// video_library row that is not retired: sign the stored source (s3Bucket/s3Key, as
// library/reanalyse.ts does), run ffmpeg (360 px, at most 30 s, H.264 + AAC) and overwrite
// library/<hash>-preview.mp4 with the ingest content type and Cache-Control. No AI or provider
// calls. Logic and tests: src/lib/studio/ops/rebuild-previews.ts. Runbook:
// runbooks/corpus-ingestion.md "Preview sound".
//
//   npx tsx scripts/library/rebuild-previews.ts --dry-run                  # count only
//   npx tsx scripts/library/rebuild-previews.ts --limit 5                  # trial batch
//   npx tsx scripts/library/rebuild-previews.ts --only-missing-audio       # everything left
//   ... [--concurrency N]   (default 2, capped by STUDIO_FFMPEG_MAX_CONCURRENT)
//
// Needs DATABASE_URL, the storage env (STORAGE_PROVIDER, R2_* or AWS_*) with read and write access
// to the library bucket, and ffmpeg/ffprobe (the production image has both).

async function main(): Promise<void> {
  const args = parseRebuildPreviewsArgs(process.argv.slice(2));
  const concurrency = effectiveConcurrency(args.concurrency);
  logger.info({ ...args, concurrency }, 'library previews: starting');
  const report = await rebuildLibraryPreviews(
    {
      items: prismaPreviewItems(prisma),
      storage: getAssetStorage(),
      media: createFfmpegInspector(),
      log: logger,
    },
    { ...args, concurrency },
  );
  logger.info(
    { ...report, failed: report.failed.slice(0, 20), failedCount: report.failed.length },
    args.dryRun ? 'dry run: nothing written' : 'library preview rebuild finished',
  );
  if (report.failed.length > 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'library preview rebuild failed');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
