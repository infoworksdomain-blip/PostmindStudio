import { Redis } from 'ioredis';
import { logger } from '@/lib/logger';
import { runReadiness } from '@/lib/studio/observability/readiness';

// GET /api/health/ready — readiness: Postgres and Redis (BullMQ, idempotency, OAuth state).
// 503 when either is down. Unauthenticated (for the load balancer); reports up/down only.
export const dynamic = 'force-dynamic';

let redis: Redis | undefined;

export async function GET(): Promise<Response> {
  const [{ prisma }, { redisConnectionFromEnv }] = await Promise.all([
    import('@/lib/prisma'),
    import('@/lib/studio/queue/redis'),
  ]);
  redis ??= new Redis({
    ...(redisConnectionFromEnv() as object),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  // Connection errors surface as a failed check; don't let ioredis report them as unhandled.
  if (redis.listenerCount('error') === 0) {
    redis.on('error', (err: Error) => logger.debug({ err }, 'readiness redis connection error'));
  }
  const client = redis;
  const report = await runReadiness(
    [
      { name: 'database', run: () => prisma.$queryRaw`SELECT 1` },
      { name: 'redis', run: () => client.ping() },
    ],
    { onFailure: (name, err) => logger.warn({ check: name, err }, 'readiness check failed') },
  );
  return Response.json(
    { ...report, service: 'postmind-studio' },
    { status: report.ok ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
}
