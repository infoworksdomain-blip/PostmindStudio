import type { Prisma } from '@prisma/client';
import { NotImplementedError, PlatformError } from '../../../errors';
import { nextPollDelayMs } from '../../analytics/schedule';
import { recordSnapshot, rollUpAnalytics, rollUpProviderUsage } from '../../analytics/store';
import type { PipelineDeps } from '../../pipeline/deps';
import { publicationMetadata, resolveCredentials } from '../../platforms/publishing';
import type { Platform } from '../../services/catalog';
import { jobIds } from '../enqueue';
import type { PollAnalyticsJobData, RollUpJobData } from '../queues';

// BACKLOG 11.1 / 11.2 — poll one publication's metrics, store the snapshot, schedule the next
// poll by age (spec 15.2). Polling stops for taken-down posts, platforms without a metrics API
// for our access level (recorded on the publication), and posts older than 12 months.

async function scheduleNext(deps: PipelineDeps, data: PollAnalyticsJobData, publishedAt: Date) {
  const delay = nextPollDelayMs(publishedAt, deps.now());
  if (delay === null) return;
  const next = { ...data, pollNumber: data.pollNumber + 1 };
  await deps.queue.add('poll-publication-analytics', next, {
    jobId: jobIds.pollAnalytics(next),
    delayMs: delay,
  });
}

async function markUnavailable(
  deps: PipelineDeps,
  id: string,
  metadata: Prisma.JsonValue,
  reason: string,
) {
  await deps.db.videoPublication.update({
    where: { id },
    data: {
      metadata: {
        ...publicationMetadata({ metadata }),
        analytics: { unavailable: reason.slice(0, 300), at: new Date(deps.now()).toISOString() },
      } as Prisma.InputJsonValue,
    },
  });
}

export async function pollPublicationAnalytics(
  data: PollAnalyticsJobData,
  deps: PipelineDeps,
): Promise<void> {
  const publication = await deps.db.videoPublication.findFirst({
    where: { id: data.publicationId, organisationId: data.organisationId },
  });
  if (
    !publication ||
    publication.state !== 'PUBLISHED' ||
    !publication.platformPostId ||
    !publication.publishedAt
  ) {
    return; // taken down, deleted or never published: stop polling
  }
  const fetcher = deps.metrics[publication.platform as Platform];
  if (!fetcher) {
    return markUnavailable(
      deps,
      publication.id,
      publication.metadata,
      `no metrics API for ${publication.platform}`,
    );
  }
  try {
    const { accessToken, accountId } = await resolveCredentials(deps.publishing, publication);
    const result = await fetcher.fetch({
      accessToken,
      accountId,
      platformPostId: publication.platformPostId,
      publishedAt: publication.publishedAt,
      now: deps.now(),
    });
    await recordSnapshot(deps.db, publication.id, result.snapshot, new Date(deps.now()));
    if (result.platformPostId && result.platformPostId !== publication.platformPostId) {
      await deps.db.videoPublication.update({
        where: { id: publication.id },
        data: { platformPostId: result.platformPostId },
      });
    }
  } catch (err) {
    if (
      err instanceof NotImplementedError ||
      (err instanceof PlatformError && err.errorClass === 'needs_reconnect')
    ) {
      return markUnavailable(deps, publication.id, publication.metadata, err.message);
    }
    throw err;
  }
  await scheduleNext(deps, data, publication.publishedAt);
}

/** Retries exhausted: keep the schedule going (spec 17.3: a missed poll backfills next cycle). */
export async function onPollPublicationAnalyticsFailed(
  data: PollAnalyticsJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  deps.logger.warn({ publicationId: data.publicationId, reason }, 'analytics poll failed');
  const publication = await deps.db.videoPublication.findFirst({
    where: { id: data.publicationId, organisationId: data.organisationId, state: 'PUBLISHED' },
    select: { publishedAt: true },
  });
  if (publication?.publishedAt) await scheduleNext(deps, data, publication.publishedAt);
}

export async function rollUpAnalyticsJob(data: RollUpJobData, deps: PipelineDeps): Promise<void> {
  const analytics = await rollUpAnalytics(deps.db, deps.now());
  const day = new Date(`${data.runId}T00:00:00.000Z`);
  const usage = await rollUpProviderUsage(
    deps.db,
    Number.isNaN(day.getTime()) ? new Date(deps.now() - 86_400_000) : day,
  );
  deps.logger.info(
    { ...analytics, providerUsageRows: usage, day: data.runId },
    'analytics rolled up',
  );
}

export async function onRollUpAnalyticsFailed(
  data: RollUpJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  deps.logger.error({ day: data.runId, reason }, 'analytics roll-up failed');
}
