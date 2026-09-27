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
import { getCircuitBreaker } from '../src/lib/studio/providers/circuit-breaker';
import { PIPELINE_QUEUES, startWorkers } from '../src/lib/studio/queue/worker-host';
import { queuePrefix } from '../src/lib/studio/queue/redis';

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
        sampleBreakers(metrics, getCircuitBreaker());
        void metrics.registry.metrics().then((body) => {
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
