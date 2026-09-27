import { logger } from '@/lib/logger';
import { getMetrics, metricsAuthorised } from '@/lib/studio/observability/metrics';
import { sampleBreakers, sampleQueueDepths } from '@/lib/studio/observability/sample';

// GET /api/metrics — Prometheus scrape endpoint (Engagement 14.14). Bind to private ingress;
// additionally requires `Authorization: Bearer $METRICS_TOKEN` (404 when no token is set, so
// an unconfigured deployment never exposes it).
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const token = process.env.METRICS_TOKEN?.trim() || undefined;
  if (!token) return new Response('Not found', { status: 404 });
  if (!metricsAuthorised(req.headers.get('authorization'), token)) {
    return new Response('Unauthorized', { status: 401 });
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
  return new Response(await metrics.registry.metrics(), {
    headers: { 'content-type': metrics.registry.contentType, 'cache-control': 'no-store' },
  });
}
