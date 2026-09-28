import type { Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { UsageEventPayload, UsageEventType, UsageReporter } from '../core/usage-reporter';

// BACKLOG 15.W2 — the studio.usage_events outbox (spec 16.1 usage events). Events are DERIVED
// from rows Studio already writes, so no pipeline step has to remember to emit them:
//   video_generated          one per composed render            eventKey render:<renderId>
//   provider_cost_incurred   one per provider job with a cost   eventKey provider_job:<jobId>
// Derivation is idempotent (unique eventKey + skipDuplicates) over a look-back window, so an
// hourly run that is missed or repeated neither loses nor doubles an event. The flush sends
// pending rows through a UsageReporter; until Core publishes its usage API the reporter is not
// ready and rows stay `pending_setup` (the backlog is sent in order once it is).

export const USAGE_LOOKBACK_HOURS = 48;
export const USAGE_FLUSH_BATCH = 500;
/** A row that failed this many sends stops being retried automatically (operator replays). */
export const USAGE_MAX_ATTEMPTS = 10;
const HOUR_MS = 60 * 60 * 1000;

type Db = Pick<PrismaClient, 'videoRender' | 'providerJob' | 'usageEvent'>;

interface DerivedEvent {
  organisationId: string;
  eventType: UsageEventType;
  eventKey: string;
  occurredAt: Date;
  payload: Prisma.InputJsonValue;
}

/** Record usage events for renders and costed provider jobs since `now - lookback`. */
export async function deriveUsageEvents(
  db: Db,
  now: number,
  lookbackHours = USAGE_LOOKBACK_HOURS,
): Promise<{ derived: number; inserted: number }> {
  const since = new Date(now - lookbackHours * HOUR_MS);
  const renders = await db.videoRender.findMany({
    where: { createdAt: { gte: since } },
    select: {
      id: true,
      projectId: true,
      targetPlatform: true,
      durationSec: true,
      resolution: true,
      createdAt: true,
      costPence: true,
      project: { select: { organisationId: true, costCurrency: true } },
    },
  });
  const jobs = await db.providerJob.findMany({
    where: { completedAt: { gte: since }, costPence: { gt: 0 } },
    select: {
      id: true,
      organisationId: true,
      projectId: true,
      provider: true,
      operation: true,
      costPence: true,
      completedAt: true,
    },
  });
  const events: DerivedEvent[] = [
    ...renders.map((r) => ({
      organisationId: r.project.organisationId,
      eventType: 'video_generated' as const,
      eventKey: `render:${r.id}`,
      occurredAt: r.createdAt,
      payload: {
        projectId: r.projectId,
        renderId: r.id,
        platform: r.targetPlatform,
        durationSec: r.durationSec,
        resolution: r.resolution,
      },
    })),
    ...jobs.map((j) => ({
      organisationId: j.organisationId,
      eventType: 'provider_cost_incurred' as const,
      eventKey: `provider_job:${j.id}`,
      occurredAt: j.completedAt ?? since,
      payload: {
        projectId: j.projectId,
        providerJobId: j.id,
        provider: j.provider,
        operation: j.operation,
        costPence: j.costPence,
        currency: 'GBP',
      },
    })),
  ];
  if (events.length === 0) return { derived: 0, inserted: 0 };
  const { count } = await db.usageEvent.createMany({
    data: events.map((e) => ({ ...e, state: 'pending_setup' })),
    skipDuplicates: true,
  });
  return { derived: events.length, inserted: count };
}

function toPayload(row: {
  organisationId: string;
  eventType: string;
  eventKey: string;
  occurredAt: Date;
  payload: Prisma.JsonValue;
}): UsageEventPayload {
  const metadata =
    row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : {};
  const cost = typeof metadata.costPence === 'number' ? metadata.costPence : undefined;
  return {
    idempotencyKey: row.eventKey,
    organisationId: row.organisationId,
    type: row.eventType as UsageEventType,
    occurredAt: row.occurredAt.toISOString(),
    quantity: 1,
    ...(cost !== undefined && { costPence: cost, currency: 'GBP' }),
    metadata,
  };
}

export interface UsageFlushResult {
  /** 'pending_setup' = the reporter is not ready (Core has not shipped the API). */
  status: 'pending_setup' | 'sent';
  pending: number;
  sent: number;
  failed: number;
}

/** Send pending events oldest first. Never throws for a Core failure: rows record it. */
export async function flushUsageEvents(
  deps: { db: Pick<PrismaClient, 'usageEvent'>; logger: Logger; now: () => number },
  reporter: UsageReporter,
): Promise<UsageFlushResult> {
  const where = {
    state: { in: ['pending_setup', 'failed'] },
    attempts: { lt: USAGE_MAX_ATTEMPTS },
  };
  if (!reporter.ready) {
    const pending = await deps.db.usageEvent.count({ where });
    return { status: 'pending_setup', pending, sent: 0, failed: 0 };
  }
  const rows = await deps.db.usageEvent.findMany({
    where,
    orderBy: { occurredAt: 'asc' },
    take: USAGE_FLUSH_BATCH,
  });
  if (rows.length === 0) return { status: 'sent', pending: 0, sent: 0, failed: 0 };
  const ids = rows.map((r) => r.id);
  try {
    await reporter.send(rows.map(toPayload));
    await deps.db.usageEvent.updateMany({
      where: { id: { in: ids } },
      data: { state: 'sent', sentAt: new Date(deps.now()), lastError: null },
    });
    return { status: 'sent', pending: 0, sent: rows.length, failed: 0 };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    deps.logger.warn({ err, events: rows.length }, 'usage events could not be sent to Core');
    await deps.db.usageEvent.updateMany({
      where: { id: { in: ids } },
      data: { state: 'failed', attempts: { increment: 1 }, lastError: message },
    });
    return { status: 'sent', pending: 0, sent: 0, failed: rows.length };
  }
}
