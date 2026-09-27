import { PrismaClient } from '@prisma/client';
import { requireEnv } from '../../src/lib/env';
import { StudioError } from '../../src/lib/errors';
import { createKillSwitch, createPrismaFlagStore } from '../../src/lib/studio/kill-switch';
import { getCircuitBreaker } from '../../src/lib/studio/providers/circuit-breaker';
import type {
  ProviderAdapter,
  ProviderPollResult,
  ProviderRequest,
} from '../../src/lib/studio/providers/interface';
import { createPrismaProviderJobRepository } from '../../src/lib/studio/providers/job-repository';
import {
  pollTracked,
  submitTracked,
  type TrackingDeps,
} from '../../src/lib/studio/providers/tracked';

// Shared harness for the GATE 2 smoke scripts. Every call goes through submitTracked /
// pollTracked, so each run exercises the kill switch, provider_jobs writes and cost tracking
// against the real database, not just the provider.

export const SMOKE_ORG_ID = 'gate2-smoke-org';

export function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function createHarness() {
  requireEnv('DATABASE_URL');
  const prisma = new PrismaClient();
  const deps: TrackingDeps = {
    repo: createPrismaProviderJobRepository(prisma),
    killSwitch: createKillSwitch({ store: createPrismaFlagStore(prisma) }),
    breaker: getCircuitBreaker(),
  };
  return { prisma, deps };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runTrackedJob(
  adapter: ProviderAdapter,
  request: ProviderRequest,
  deps: TrackingDeps,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<{ jobId: string; result: ProviderPollResult }> {
  const pollIntervalMs = options.pollIntervalMs ?? 5_000; // Runway: poll no faster than 5s
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);

  out(`→ submitting ${request.capability} to ${adapter.providerId} …`);
  const submitted = await submitTracked(adapter, request, deps);
  out(`  provider job id : ${submitted.providerJobId}`);
  out(`  estimated cost  : ${submitted.estimatedCostPence}p`);
  out(`  provider_jobs   : ${submitted.jobId}`);

  for (;;) {
    const result = await pollTracked(
      adapter,
      submitted.jobId,
      { organisationId: request.organisationId },
      deps,
    );
    if (result.state !== 'running') return { jobId: submitted.jobId, result };
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${adapter.providerId}`);
    out(`  … still running (${new Date().toISOString()})`);
    await sleep(pollIntervalMs);
  }
}

export async function printJobRow(prisma: PrismaClient, jobId: string): Promise<boolean> {
  const row = await prisma.providerJob.findUnique({ where: { id: jobId } });
  if (!row) {
    out('✗ provider_jobs row NOT found');
    return false;
  }
  out('✓ provider_jobs row:');
  out(
    JSON.stringify(
      {
        id: row.id,
        provider: row.provider,
        operation: row.operation,
        state: row.state,
        providerJobId: row.providerJobId,
        costPence: row.costPence,
        durationMs: row.durationMs,
        errorClass: row.errorClass,
      },
      null,
      2,
    ),
  );
  const usage = await prisma.providerUsage.findFirst({
    where: { organisationId: row.organisationId, provider: row.provider },
    orderBy: { day: 'desc' },
  });
  out(`✓ provider_usage today: ${usage ? `${usage.jobCount} jobs, ${usage.costPence}p` : 'none'}`);
  return true;
}

/** Run a script body with consistent error reporting and exit codes. */
export function main(body: () => Promise<boolean>): void {
  body()
    .then((ok) => {
      process.exitCode = ok ? 0 : 1;
    })
    .catch((err: unknown) => {
      if (err instanceof StudioError) {
        out(`✗ ${err.name} (${err.code}): ${err.message}`);
        if (err.details) out(`  ${JSON.stringify(err.details)}`);
      } else {
        out(`✗ ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }
      process.exitCode = 1;
    });
}
