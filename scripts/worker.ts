import { PrismaClient } from '@prisma/client';
import { logger } from '../src/lib/logger';
import { createPipelineDeps } from '../src/lib/studio/pipeline/create-deps';
import { createBullJobQueue } from '../src/lib/studio/queue/enqueue';
import { QUEUES, type QueueName } from '../src/lib/studio/queue/queues';
import { redisConnectionFromEnv } from '../src/lib/studio/queue/redis';
import { PIPELINE_QUEUES, startWorkers } from '../src/lib/studio/queue/worker-host';

// BACKLOG 3.10 — worker process entry point, run separately from the Next.js server:
//   npm run worker                          # all pipeline queues
//   npm run worker -- studio-assets         # one queue (scale queues independently, spec 11.3)
// Requires REDIS_URL (DB 3), DATABASE_URL, provider keys, S3 buckets and ffmpeg/ffprobe.

async function main(): Promise<void> {
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

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'stopping workers (finishing in-flight jobs)');
    await Promise.all(workers.map((w) => w.close()));
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
