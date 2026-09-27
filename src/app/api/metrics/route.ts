import { logger } from '@/lib/logger';
import { getMetrics, metricsAuthorised } from '@/lib/studio/observability/metrics';
import {
  sampleBreakers,
  sampleKillSwitch,
  sampleQueueDepths,
} from '@/lib/studio/observability/sample';

// GET /api/metrics — Prometheus scrape endpoint (Engagement 14.14). Bind to private ingress;
// additionally requires `Authorization: Bearer $METRICS_TOKEN`. Anything else — no token set,
// no or wrong bearer — is a 404.
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const token = process.env.METRICS_TOKEN?.trim() || undefined;
  if (!token) return new Response('Not found', { status: 404 });
  if (!metricsAuthorised(req.headers.get('authorization'), token)) {
    // Same answer as "disabled": don't reveal whether the endpoint is configured.
    return new Response('Not found', { status: 404 });
  }
  const metrics = getMetrics();
  const [{ redisConnectionFromEnv }, { getCircuitBreaker }] = await Promise.all([
    import('@/lib/studio/queue/redis'),
    import('@/lib/studio/providers/circuit-breaker'),
  ]);
  sampleBreakers(metrics, getCircuitBreaker());
  await sampleQueueDepths(metrics, redisConnectionFromEnv()).catch((err: unknown) =>
    logger.warn({ err }, 'queue depth sampling failed'),
  );
  const { prisma } = await import('@/lib/prisma');
  await sampleKillSwitch(metrics, prisma).catch((err: unknown) =>
    logger.warn({ err }, 'kill switch sampling failed'),
  );
  return new Response(await metrics.registry.metrics(), {
    headers: { 'content-type': metrics.registry.contentType, 'cache-control': 'no-store' },
  });
}
