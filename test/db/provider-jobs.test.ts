import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKillSwitch, createPrismaFlagStore } from '../../src/lib/studio/kill-switch';
import { createPrismaBudgetChecker } from '../../src/lib/studio/providers/budget';
import { createCircuitBreaker } from '../../src/lib/studio/providers/circuit-breaker';
import { createPrismaProviderJobRepository } from '../../src/lib/studio/providers/job-repository';
import { StubAdapter } from '../../src/lib/studio/providers/test-adapter';
import { pollTracked, submitTracked } from '../../src/lib/studio/providers/tracked';

// Runs against a real migrated Postgres (the CI `database` job). Skipped when DATABASE_URL
// is not set. Proves BACKLOG 2.11 end to end through Prisma: provider_jobs lifecycle,
// provider_usage daily upsert, and the project's costActualPence tally.

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('provider job tracking on real Postgres', () => {
  const prisma = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const organisationId = `db-test-${randomUUID()}`;
  let projectId: string;

  beforeAll(async () => {
    const project = await prisma.videoProject.create({
      data: {
        organisationId,
        businessId: 'biz-1',
        createdByUserId: 'user-1',
        name: 'DB test',
        state: 'DRAFT',
        sourceType: 'BRIEF',
        targetFormats: [],
        costBudgetPence: 100,
      },
    });
    projectId = project.id;
  });

  afterAll(async () => {
    await prisma.providerJob.deleteMany({ where: { organisationId } });
    await prisma.providerUsage.deleteMany({ where: { organisationId } });
    await prisma.videoProject.deleteMany({ where: { organisationId } });
    await prisma.$disconnect();
  });

  it('writes provider_jobs, provider_usage and the project cost tally', async () => {
    const deps = {
      repo: createPrismaProviderJobRepository(prisma),
      killSwitch: createKillSwitch({ store: createPrismaFlagStore(prisma) }),
      breaker: createCircuitBreaker(),
    };
    const adapter = new StubAdapter('runway', ['text_to_video'], { costPence: 45 });
    const request = {
      capability: 'text_to_video' as const,
      organisationId,
      projectId,
      prompt: 'bread',
      durationSec: 5,
      aspectRatio: '9:16' as const,
    };

    for (const cost of [40, 30]) {
      const { jobId } = await submitTracked(adapter, request, deps);
      adapter.nextPoll = async () => ({
        state: 'succeeded',
        output: { metadata: { costPence: cost } },
      });
      await pollTracked(adapter, jobId, { organisationId }, deps);
    }

    const jobs = await prisma.providerJob.findMany({
      where: { organisationId },
      orderBy: { startedAt: 'asc' },
    });
    expect(jobs.map((j) => [j.state, j.costPence])).toEqual([
      ['SUCCEEDED', 40],
      ['SUCCEEDED', 30],
    ]);

    const usage = await prisma.providerUsage.findMany({ where: { organisationId } });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      provider: 'runway',
      jobCount: 2,
      succeededCount: 2,
      costPence: 70,
    });

    const project = await prisma.videoProject.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.costActualPence).toBe(70);

    const budget = createPrismaBudgetChecker(prisma);
    const ask = { organisationId, projectId, providerId: 'runway' };
    await expect(budget.hasBudget({ ...ask, estimatedCostPence: 30 })).resolves.toBe(true);
    await expect(budget.hasBudget({ ...ask, estimatedCostPence: 31 })).resolves.toBe(false);
  });
});
