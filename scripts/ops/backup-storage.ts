import { S3Client } from '@aws-sdk/client-s3';
import { logger } from '../../src/lib/logger';
import { backupConfigFromEnv, parseBackupArgs } from '../../src/lib/studio/ops/storage-backup';
import {
  createS3BackupIo,
  formatReport,
  runBackup,
} from '../../src/lib/studio/ops/storage-backup-run';

// Phase 17.5 — copy new and changed objects from Studio's buckets into the backup bucket, and age
// out copies whose source was deleted more than S3_BACKUP_RETENTION_DAYS (default 30) ago.
// runbooks/backup-recovery.md. Render runs it daily as the studio-backup-storage-<env> cron job.
//
//   STORAGE_PROVIDER=r2 R2_ACCOUNT_ID=... R2_JURISDICTION=eu S3_BUCKET_ASSETS=... \
//   S3_BUCKET_RENDERS=... S3_BUCKET_THUMBNAILS=... S3_BACKUP_BUCKET=... \
//   S3_BACKUP_ACCESS_KEY_ID=... S3_BACKUP_SECRET_ACCESS_KEY=... \
//     npx tsx scripts/ops/backup-storage.ts                  # dry run: plan only
//     npx tsx scripts/ops/backup-storage.ts --apply          # copy, age out, write state
//     ... [--only assets,renders,thumbnails,library] [--concurrency 8] [--allow-mass-tombstone]
//
// Exit 1 when anything failed (a copy, a delete, a listing) or the mass-tombstone valve stopped a
// bucket, so Render marks the cron run failed and notifies. No database access.

async function main(): Promise<void> {
  const args = parseBackupArgs(process.argv.slice(2));
  const config = backupConfigFromEnv(process.env, args.only);
  const io = createS3BackupIo({
    source: new S3Client(config.sourceClient),
    backup: new S3Client(config.backupClient),
    serverSideCopy: config.serverSideCopy,
  });
  const report = await runBackup(io, {
    sources: config.sources,
    skipped: config.skipped,
    backupBucket: config.backupBucket,
    retentionDays: config.retentionDays,
    serverSideCopy: config.serverSideCopy,
    apply: args.apply,
    allowMassTombstone: args.allowMassTombstone,
    concurrency: args.concurrency,
    log: logger,
  });
  process.stdout.write(`${formatReport(report)}\n`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((err: unknown) => {
  logger.error({ err, event: 'storage_backup_run', ok: false }, 'backup-storage failed');
  process.exitCode = 1;
});
