import type { Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { budgetFormatsFromJson, isLongForm } from '../cost/project-budget';
import { projectMetadata } from '../pipeline/project-state';
import { getMetrics, type StudioMetrics } from './metrics';

// BACKLOG 15.D9 — SLO and acceptance metrics (spec 17.1 latency SLOs, spec 3.5 acceptance
// criteria). Each helper is a single call at the point where the measured event happens, so the
// worker files it is called from (other tracks') only gain one line each:
//   services/projects.ts generateProject   → generationStartMetadata (the start of the clock)
//   queue/workers/run-quality-gate.ts      → recordQualityGateOutcome
//   queue/workers/publish-video.ts         → recordPublished / recordPublishFailed
//   queue/workers/poll-analytics.ts        → observeFirstAnalyticsSample
// Recording rules and alerts: ops/prometheus/studio-slo.yml. Metrics never throw into the
// pipeline: a measurement that can't be taken is skipped (and logged where a logger exists).

export type GenerationKind = 'short_form' | 'long_form' | 'slideshow';

/**
 * The generate call's run and time, kept in project metadata until READY_FOR_REVIEW. A type
 * alias (not an interface) so it stays assignable to Prisma's JSON input type.
 */
export type GenerationStart = { runId: string; at: string };

/** Metadata fragment generateProject merges in: the SLO clock starts at the generate call. */
export function generationStartMetadata(
  runId: string,
  now: number,
): { generationStart: GenerationStart } {
  return { generationStart: { runId, at: new Date(now).toISOString() } };
}

/** Kind label from the project's own fields: slideshow source, else long-form by formats. */
export function generationKind(project: {
  sourceType: string;
  targetFormats: Prisma.JsonValue;
}): GenerationKind {
  if (project.sourceType === 'SLIDESHOW') return 'slideshow';
  return isLongForm(budgetFormatsFromJson(project.targetFormats)) ? 'long_form' : 'short_form';
}

/**
 * Seconds from the generate call to now, or null when this run did not start at a generate
 * call (a script/shot regeneration or an overlay re-render keeps the old generationStart but
 * has a newer runId) or the clock went backwards.
 */
export function generationSeconds(metadata: Prisma.JsonValue | null, now: number): number | null {
  const meta = projectMetadata(metadata);
  const start = meta.generationStart as Partial<GenerationStart> | undefined;
  if (!start || typeof start.at !== 'string' || start.runId !== meta.runId) return null;
  const startedAt = Date.parse(start.at);
  if (Number.isNaN(startedAt) || now < startedAt) return null;
  return (now - startedAt) / 1000;
}

/**
 * The quality gate finished for a run. `passed` is one entry per render; `moved` is whether
 * this run's transition applied (a superseded run is not counted). All renders passing means
 * the project reached READY_FOR_REVIEW: the generation histogram is observed then.
 */
export function recordQualityGateOutcome(
  input: {
    project: { sourceType: string; targetFormats: Prisma.JsonValue; metadata: Prisma.JsonValue };
    passed: boolean[];
    moved: boolean;
    now: number;
  },
  metrics: StudioMetrics = getMetrics(),
): void {
  if (!input.moved) return;
  for (const ok of input.passed) metrics.qualityGate.inc({ result: ok ? 'pass' : 'fail' });
  if (input.passed.length === 0 || !input.passed.every(Boolean)) return;
  const seconds = generationSeconds(input.project.metadata, input.now);
  if (seconds !== null) {
    metrics.generationDuration.observe({ kind: generationKind(input.project) }, seconds);
  }
}

/**
 * A publication went live. The spec measures "approve → publication.publishedAt"; a publication
 * is created at (or after) approval and may be scheduled later, so the clock starts at the later
 * of its creation and its scheduled time. First attempt = the job found it SCHEDULED (a BullMQ
 * retry finds it PUBLISHING) and it had never failed before (retryCount 0).
 */
export function recordPublished(
  publication: {
    platform: string;
    state: string;
    retryCount: number;
    createdAt: Date;
    scheduledFor: Date | null;
  },
  now: number,
  metrics: StudioMetrics = getMetrics(),
): void {
  const firstAttempt = publication.state === 'SCHEDULED' && publication.retryCount === 0;
  metrics.publications.inc({
    platform: publication.platform,
    outcome: firstAttempt ? 'first_attempt' : 'after_retry',
  });
  const due = Math.max(
    publication.createdAt.getTime(),
    publication.scheduledFor?.getTime() ?? Number.NEGATIVE_INFINITY,
  );
  if (now >= due) {
    metrics.publishLatency.observe({ platform: publication.platform }, (now - due) / 1000);
  }
}

/**
 * A publication failed for good (retries exhausted). The job payload has no platform, so it is
 * read from the row; never throws (a failed lookup is logged and the failure handling goes on).
 */
export async function recordPublishFailed(
  deps: { db: Pick<PrismaClient, 'videoPublication'>; logger: Pick<Logger, 'warn'> },
  publicationId: string,
  metrics: StudioMetrics = getMetrics(),
): Promise<void> {
  try {
    const row = await deps.db.videoPublication.findUnique({
      where: { id: publicationId },
      select: { platform: true },
    });
    if (row) metrics.publications.inc({ platform: row.platform, outcome: 'failed' });
  } catch (err) {
    deps.logger.warn({ err, publicationId }, 'publish success-rate metric skipped');
  }
}

/**
 * Call just before storing an analytics snapshot: when the publication has no analytics rows
 * yet, this is its first sample, and publishedAt → now is observed. Never throws (a failed
 * count is logged and the poll carries on).
 */
export async function observeFirstAnalyticsSample(
  deps: { db: Pick<PrismaClient, 'videoAnalytic'>; logger: Pick<Logger, 'warn'> },
  publication: { id: string; platform: string; publishedAt: Date | null },
  now: number,
  metrics: StudioMetrics = getMetrics(),
): Promise<void> {
  if (!publication.publishedAt) return;
  const publishedAt = publication.publishedAt;
  try {
    const existing = await deps.db.videoAnalytic.count({
      where: { publicationId: publication.id },
    });
    if (existing > 0) return;
    const seconds = (now - publishedAt.getTime()) / 1000;
    if (seconds >= 0)
      metrics.analyticsFirstMetric.observe({ platform: publication.platform }, seconds);
  } catch (err) {
    deps.logger.warn(
      { err, publicationId: publication.id },
      'analytics freshness metric skipped: could not count existing samples',
    );
  }
}
