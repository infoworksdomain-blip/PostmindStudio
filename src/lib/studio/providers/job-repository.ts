import type { Prisma, PrismaClient } from '@prisma/client';

// Persistence for BACKLOG 2.11: one studio.provider_jobs row per provider call, rolled up
// into studio.provider_usage per (organisation, provider, UTC day), and the project's running
// cost tally (video_projects.costActualPence, spec 12.5).

const MAX_STORED_JSON_CHARS = 16_000; // spec 7.10: "truncated for size"

export interface NewProviderJob {
  organisationId: string;
  projectId?: string;
  provider: string;
  operation: string;
  requestBody: unknown;
}

export interface ProviderJobRecord {
  id: string;
  organisationId: string;
  projectId: string | null;
  provider: string;
  providerJobId: string | null;
  state: string;
  startedAt: Date;
  costPence: number;
}

export interface ProviderJobRepository {
  create(job: NewProviderJob): Promise<ProviderJobRecord>;
  find(id: string): Promise<ProviderJobRecord | null>;
  markRunning(id: string, providerJobId: string, estimatedCostPence: number): Promise<void>;
  markSucceeded(
    id: string,
    outcome: { responseBody: unknown; costPence: number; completedAt: Date; durationMs: number },
  ): Promise<void>;
  markFailed(
    id: string,
    outcome: {
      errorClass: string;
      errorMessage: string;
      completedAt: Date;
      durationMs: number;
      state?: 'FAILED' | 'TIMED_OUT' | 'CANCELLED';
    },
  ): Promise<void>;
  recordUsage(usage: {
    organisationId: string;
    provider: string;
    day: Date;
    succeeded: boolean;
    costPence: number;
    projectId?: string | null;
  }): Promise<void>;
}

/** Keep stored JSON bounded. Oversized payloads are replaced with a marker, not cut mid-JSON. */
export function truncateForStorage(value: unknown): Prisma.InputJsonValue {
  const json = JSON.stringify(value ?? null, (_key, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
  if (json.length <= MAX_STORED_JSON_CHARS) return JSON.parse(json) as Prisma.InputJsonValue;
  return {
    truncated: true,
    originalLength: json.length,
    preview: json.slice(0, MAX_STORED_JSON_CHARS),
  };
}

export function utcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

type ProviderJobClient = Pick<
  PrismaClient,
  'providerJob' | 'providerUsage' | 'videoProject' | '$transaction'
>;

export function createPrismaProviderJobRepository(db: ProviderJobClient): ProviderJobRepository {
  return {
    async create(job) {
      return db.providerJob.create({
        data: {
          organisationId: job.organisationId,
          projectId: job.projectId ?? null,
          provider: job.provider,
          operation: job.operation,
          requestBody: truncateForStorage(job.requestBody),
          state: 'PENDING',
        },
      });
    },
    async find(id) {
      return db.providerJob.findUnique({ where: { id } });
    },
    async markRunning(id, providerJobId, estimatedCostPence) {
      await db.providerJob.update({
        where: { id },
        data: { state: 'RUNNING', providerJobId, costPence: estimatedCostPence },
      });
    },
    async markSucceeded(id, outcome) {
      await db.providerJob.update({
        where: { id },
        data: {
          state: 'SUCCEEDED',
          responseBody: truncateForStorage(outcome.responseBody),
          costPence: outcome.costPence,
          completedAt: outcome.completedAt,
          durationMs: outcome.durationMs,
        },
      });
    },
    async markFailed(id, outcome) {
      await db.providerJob.update({
        where: { id },
        data: {
          state: outcome.state ?? 'FAILED',
          errorClass: outcome.errorClass,
          errorMessage: outcome.errorMessage.slice(0, 2_000),
          completedAt: outcome.completedAt,
          durationMs: outcome.durationMs,
        },
      });
    },
    async recordUsage(usage) {
      const day = utcDay(usage.day);
      const counters = {
        jobCount: 1,
        succeededCount: usage.succeeded ? 1 : 0,
        failedCount: usage.succeeded ? 0 : 1,
        costPence: usage.costPence,
      };
      await db.$transaction([
        db.providerUsage.upsert({
          where: {
            organisationId_provider_day: {
              organisationId: usage.organisationId,
              provider: usage.provider,
              day,
            },
          },
          create: {
            organisationId: usage.organisationId,
            provider: usage.provider,
            day,
            ...counters,
          },
          update: {
            jobCount: { increment: counters.jobCount },
            succeededCount: { increment: counters.succeededCount },
            failedCount: { increment: counters.failedCount },
            costPence: { increment: counters.costPence },
          },
        }),
        ...(usage.projectId && usage.costPence > 0
          ? [
              db.videoProject.update({
                where: { id: usage.projectId },
                data: { costActualPence: { increment: usage.costPence } },
              }),
            ]
          : []),
      ]);
    },
  };
}
