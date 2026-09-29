import { PrismaClient } from '@prisma/client';
import { logger } from '../src/lib/logger';
import { createPipelineDeps } from '../src/lib/studio/pipeline/create-deps';
import { createBullJobQueue } from '../src/lib/studio/queue/enqueue';
import { QUEUES, type QueueName } from '../src/lib/studio/queue/queues';
import { redisConnectionFromEnv } from '../src/lib/studio/queue/redis';
import { createServer } from 'node:http';
import { Queue } from 'bullmq';
import { getMetrics, metricsAuthorised } from '../src/lib/studio/observability/metrics';
import { sampleBreakers } from '../src/lib/studio/observability/sample';
import { getSharedCircuitBreaker } from '../src/lib/studio/providers/circuit-breaker-redis';
import { PIPELINE_QUEUES, startWorkers } from '../src/lib/studio/queue/worker-host';
import { queuePrefix } from '../src/lib/studio/queue/redis';
import { APPROVAL_CHECK_SCHEDULE } from '../src/lib/studio/queue/workers/check-approvals';
import { STYLE_MEMORY_SCHEDULE } from '../src/lib/studio/queue/workers/build-style-memory';
import { CHANNEL_RECONCILE_SCHEDULE } from '../src/lib/studio/queue/workers/reconcile-channels';
import { SAFETY_AUDIT_SCHEDULE } from '../src/lib/studio/services/safety-audit';
import { RESCAN_SWEEP_PATTERN, STOCK_REFRESH_PATTERN } from '../src/lib/studio/scan/schedule';
import { DOMAIN_POLL_PATTERN } from '../src/lib/studio/scan/domain-verification';
import { OUTBOX_DISPATCH_SCHEDULE } from '../src/lib/studio/automation/outbox';
import { AUTO_RESUME_SCHEDULE } from '../src/lib/studio/services/auto-resume';
import type { JobName } from '../src/lib/studio/queue/queues';
import { RETENTION_SWEEP_SCHEDULE } from '../src/lib/studio/queue/workers/retention-sweep';
import {
  CALENDAR_SYNC_SCHEDULE,
  ORGANISATION_RECONCILE_SCHEDULE,
  USAGE_REPORT_SCHEDULE,
} from '../src/lib/studio/queue/workers/core-sync';
import { HARD_DELETE_SCHEDULE } from '../src/lib/studio/services/organisation-hard-delete';
import { UPLOAD_SWEEP_SCHEDULE } from '../src/lib/studio/services/upload-sweep';
import { LOST_PUBLISH_SCHEDULE } from '../src/lib/studio/services/lost-publications';
import { ACCOUNT_CHECK_SCHEDULE } from '../src/lib/studio/services/account-status';
import { EMAIL_SWEEP_SCHEDULE } from '../src/lib/studio/queue/workers/send-email';

// BACKLOG 3.10 — worker process entry point, run separately from the Next.js server:
//   npm run worker                          # all pipeline queues
//   npm run worker -- studio-assets         # one queue (scale queues independently, spec 11.3)
// Requires REDIS_URL (DB 3), DATABASE_URL, provider keys, S3 buckets and ffmpeg/ffprobe.

async function main(): Promise<void> {
  // BACKLOG 11.6 — Sentry in the worker process (@sentry/node), only when SENTRY_DSN is set.
  const dsn = process.env.SENTRY_DSN?.trim();
  if (dsn) {
    const Sentry = await import('@sentry/node');
    Sentry.init({ dsn, environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV });
  }

  const requested = process.argv.slice(2) as QueueName[];
  const known = new Set<string>(Object.values(QUEUES));
  const unknown = requested.filter((q) => !known.has(q));
  if (unknown.length) throw new Error(`Unknown queue(s): ${unknown.join(', ')}`);

  const connection = redisConnectionFromEnv();
  const db = new PrismaClient();
  const queue = createBullJobQueue(connection);
  const deps = createPipelineDeps({ db, queue });
  const workers = startWorkers({
    connection,
    deps,
    queues: requested.length ? requested : PIPELINE_QUEUES,
  });
  logger.info({ queues: workers.map((w) => w.name) }, 'studio workers started');

  // BACKLOG 11.2 — nightly roll-up at 02:15 UTC (idempotent: upsert of one scheduler).
  const analytics = new Queue(QUEUES.analytics, { connection, prefix: queuePrefix() });
  await analytics.upsertJobScheduler(
    'roll-up-analytics-daily',
    { pattern: '15 2 * * *', tz: 'UTC' },
    {
      name: 'roll-up-analytics',
      data: { organisationId: 'postmind-platform', runId: 'daily', planTier: 'STANDARD' },
    },
  );
  // BACKLOG 13.29 — nightly style memory, after the roll-up so retention is fresh.
  await analytics.upsertJobScheduler(
    'build-style-memory-daily',
    { pattern: STYLE_MEMORY_SCHEDULE, tz: 'UTC' },
    {
      name: 'build-style-memory',
      data: { organisationId: 'postmind-platform', runId: 'style-memory', planTier: 'STANDARD' },
    },
  );
  // Spec 14.4 — "approval required" reminders for projects waiting > 2 h (every 15 minutes).
  await analytics.upsertJobScheduler(
    'check-pending-approvals',
    { pattern: APPROVAL_CHECK_SCHEDULE, tz: 'UTC' },
    {
      name: 'check-pending-approvals',
      data: { organisationId: 'postmind-platform', runId: 'approvals', planTier: 'STANDARD' },
    },
  );
  // BACKLOG 13.35 — daily Core ↔ Studio Meta channel reconciliation (skipped until Core ships
  // its list-channels endpoint).
  await analytics.upsertJobScheduler(
    'reconcile-channels-daily',
    { pattern: CHANNEL_RECONCILE_SCHEDULE, tz: 'UTC' },
    {
      name: 'reconcile-channels',
      data: {
        organisationId: 'postmind-platform',
        runId: 'reconcile-channels',
        planTier: 'STANDARD',
      },
    },
  );
  // BACKLOG 14.11 — monthly Trust & Safety audit sample (06:00 UTC on the 1st, last month).
  await analytics.upsertJobScheduler(
    'sample-safety-audit-monthly',
    { pattern: SAFETY_AUDIT_SCHEDULE, tz: 'UTC' },
    {
      name: 'sample-safety-audit',
      data: { organisationId: 'postmind-platform', runId: 'safety-audit', planTier: 'STANDARD' },
    },
  );

  // BACKLOG 15.E8 / 15.W2–W4 (track E) — the daily spec 7.15 retention sweep, and the PostMind
  // Core sync jobs (usage events hourly, calendar shadows every 5 minutes, organisation
  // reconciliation nightly). The Core jobs keep their outbox rows pending_setup / skip until Core
  // publishes the APIs they wait for.
  const trackE: Array<[id: string, pattern: string, name: JobName]> = [
    ['retention-sweep-daily', RETENTION_SWEEP_SCHEDULE, 'retention-sweep'],
    ['report-usage-hourly', USAGE_REPORT_SCHEDULE, 'report-usage'],
    ['sync-calendar-shadows', CALENDAR_SYNC_SCHEDULE, 'sync-calendar-shadows'],
    ['reconcile-organisations-daily', ORGANISATION_RECONCILE_SCHEDULE, 'reconcile-organisations'],
  ];
  for (const [id, pattern, name] of trackE) {
    await analytics.upsertJobScheduler(
      id,
      { pattern, tz: 'UTC' },
      { name, data: { organisationId: 'postmind-platform', runId: name, planTier: 'STANDARD' } },
    );
  }

  // BACKLOG 13.10 / 13.11 (Addendum A6.6 / A6.7) — scheduled rescans, weekly stock refresh and
  // the DNS TXT verification poll, on studio-assets.
  const assets = new Queue(QUEUES.assets, { connection, prefix: queuePrefix() });
  const platformJob = (runId: string) => ({
    organisationId: 'postmind-platform',
    runId,
    planTier: 'STANDARD' as const,
  });
  await assets.upsertJobScheduler(
    'sweep-website-rescans-daily',
    { pattern: RESCAN_SWEEP_PATTERN, tz: 'UTC' },
    { name: 'sweep-website-rescans', data: platformJob('rescans') },
  );
  await assets.upsertJobScheduler(
    'sweep-stock-refresh-weekly',
    { pattern: STOCK_REFRESH_PATTERN, tz: 'UTC' },
    { name: 'sweep-stock-refresh', data: platformJob('stock-refresh') },
  );
  await assets.upsertJobScheduler(
    'poll-domain-verifications',
    { pattern: DOMAIN_POLL_PATTERN, tz: 'UTC' },
    { name: 'poll-domain-verifications', data: platformJob('domain-verifications') },
  );

  // BACKLOG 13.20 / 13.21 (track A3) — rollover auto-resume of cost-cap paused projects
  // (00:05 UTC daily; the 1st of the month resumes monthly pauses) and the auto-publish outbox
  // dispatcher (every minute).
  const orchestration = new Queue(QUEUES.orchestration, { connection, prefix: queuePrefix() });
  const publish = new Queue(QUEUES.publish, { connection, prefix: queuePrefix() });
  await orchestration.upsertJobScheduler(
    'auto-resume-paused-daily',
    { pattern: AUTO_RESUME_SCHEDULE, tz: 'UTC' },
    {
      name: 'auto-resume-paused',
      data: { organisationId: 'postmind-platform', runId: 'auto-resume', planTier: 'STANDARD' },
    },
  );
  // BACKLOG 14.1 / 14.2 — daily data retention: hard delete of organisations past the purge
  // grace (STUDIO_PURGE_GRACE_DAYS) and the sweep of abandoned browser uploads.
  await orchestration.upsertJobScheduler(
    'hard-delete-purged-orgs-daily',
    { pattern: HARD_DELETE_SCHEDULE, tz: 'UTC' },
    {
      name: 'hard-delete-purged-orgs',
      data: { organisationId: 'postmind-platform', runId: 'hard-delete', planTier: 'STANDARD' },
    },
  );
  await orchestration.upsertJobScheduler(
    'sweep-abandoned-uploads-daily',
    { pattern: UPLOAD_SWEEP_SCHEDULE, tz: 'UTC' },
    {
      name: 'sweep-abandoned-uploads',
      data: { organisationId: 'postmind-platform', runId: 'upload-sweep', planTier: 'STANDARD' },
    },
  );
  // BACKLOG 17.2 — publications whose publish job was lost between commit and enqueue.
  await publish.upsertJobScheduler(
    'redrive-lost-publications',
    { pattern: LOST_PUBLISH_SCHEDULE, tz: 'UTC' },
    {
      name: 'redrive-lost-publications',
      data: { organisationId: 'postmind-platform', runId: 'lost-publish', planTier: 'STANDARD' },
    },
  );
  // BACKLOG 17.3 — account-status check: hourly, each connection at most once a day.
  await analytics.upsertJobScheduler(
    'check-platform-accounts-hourly',
    { pattern: ACCOUNT_CHECK_SCHEDULE, tz: 'UTC' },
    {
      name: 'check-platform-accounts',
      data: { organisationId: 'postmind-platform', runId: 'account-check', planTier: 'STANDARD' },
    },
  );
  await publish.upsertJobScheduler(
    'dispatch-auto-publish',
    { pattern: OUTBOX_DISPATCH_SCHEDULE, tz: 'UTC' },
    {
      name: 'dispatch-auto-publish',
      data: { organisationId: 'postmind-platform', runId: 'auto-publish', planTier: 'STANDARD' },
    },
  );

  // Phase 18 §2.8 — the email outbox sweeper: re-enqueues rows whose send-email job was lost and
  // purges old rows (every 5 minutes, on studio-email).
  const email = new Queue(QUEUES.email, { connection, prefix: queuePrefix() });
  await email.upsertJobScheduler(
    'sweep-email-outbox',
    { pattern: EMAIL_SWEEP_SCHEDULE, tz: 'UTC' },
    {
      name: 'sweep-email-outbox',
      data: { organisationId: 'postmind-platform', runId: 'email-sweep', planTier: 'STANDARD' },
    },
  );

  // BACKLOG 11.5 — this process's metrics (job outcomes, durations, breakers) for Prometheus.
  const metricsToken = process.env.METRICS_TOKEN?.trim() || undefined;
  const metricsServer = metricsToken
    ? createServer((req, res) => {
        if (
          req.url !== '/metrics' ||
          !metricsAuthorised(req.headers.authorization ?? null, metricsToken)
        ) {
          res.writeHead(404).end();
          return;
        }
        const metrics = getMetrics();
        void sampleBreakers(metrics, getSharedCircuitBreaker())
          .then(() => metrics.registry.metrics())
          .then((body) => {
            res.writeHead(200, { 'content-type': metrics.registry.contentType }).end(body);
          });
      }).listen(Number(process.env.WORKER_METRICS_PORT) || 9464)
    : undefined;

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'stopping workers (finishing in-flight jobs)');
    await Promise.all(workers.map((w) => w.close()));
    await analytics.close();
    await assets.close();
    await orchestration.close();
    await publish.close();
    await email.close();
    metricsServer?.close();
    await queue.close();
    await db.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  logger.error({ err }, 'worker failed to start');
  process.exit(1);
});
