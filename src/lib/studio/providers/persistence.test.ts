import type { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationError } from '../../errors';
import { createPrismaBudgetChecker, orgProviderDailyCapFromEnv } from './budget';
import { createPrismaProviderJobRepository, truncateForStorage, utcDay } from './job-repository';

afterEach(() => vi.unstubAllEnvs());

function fakeDb() {
  const calls: Array<[string, unknown]> = [];
  const model = (name: string, returns: unknown = {}) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) =>
          vi.fn(async (args: unknown) => {
            calls.push([`${name}.${method}`, args]);
            return typeof returns === 'function'
              ? (returns as (a: unknown) => unknown)(args)
              : returns;
          }),
      },
    );
  const db = {
    providerJob: model('providerJob', { id: 'job-1', startedAt: new Date(0) }),
    providerUsage: model('providerUsage'),
    videoProject: model('videoProject'),
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return { db: db as unknown as PrismaClient, calls };
}

describe('truncateForStorage and utcDay', () => {
  it('keeps small payloads and replaces oversized ones with a marker', () => {
    expect(truncateForStorage({ a: 1n })).toEqual({ a: '1' });
    const big = truncateForStorage({ s: 'x'.repeat(20_000) }) as {
      truncated: boolean;
      preview: string;
    };
    expect(big.truncated).toBe(true);
    expect(big.preview).toHaveLength(16_000);
    expect(truncateForStorage(undefined)).toBeNull();
  });

  it('floors to the UTC day', () => {
    expect(utcDay(new Date('2026-09-27T23:59:59.999Z')).toISOString()).toBe(
      '2026-09-27T00:00:00.000Z',
    );
  });
});

describe('Prisma provider job repository', () => {
  it('writes provider_jobs rows through the lifecycle', async () => {
    const { db, calls } = fakeDb();
    const repo = createPrismaProviderJobRepository(db);
    await repo.create({
      organisationId: 'o',
      provider: 'runway',
      operation: 'text_to_video',
      requestBody: { p: 1 },
    });
    await repo.find('job-1');
    await repo.markRunning('job-1', 'task-1', 45);
    await repo.markSucceeded('job-1', {
      responseBody: { url: 'u' },
      costPence: 40,
      completedAt: new Date(1),
      durationMs: 1,
    });
    await repo.markFailed('job-1', {
      errorClass: 'timeout',
      errorMessage: 'e'.repeat(3000),
      completedAt: new Date(1),
      durationMs: 1,
    });
    expect(calls.map(([name]) => name)).toEqual([
      'providerJob.create',
      'providerJob.findUnique',
      'providerJob.update',
      'providerJob.update',
      'providerJob.update',
    ]);
    expect(calls[0]?.[1]).toMatchObject({
      data: { state: 'PENDING', projectId: null, requestBody: { p: 1 } },
    });
    expect(calls[2]?.[1]).toMatchObject({
      data: { state: 'RUNNING', providerJobId: 'task-1', costPence: 45 },
    });
    expect((calls[4]?.[1] as { data: { errorMessage: string; state: string } }).data).toMatchObject(
      { state: 'FAILED' },
    );
    expect((calls[4]?.[1] as { data: { errorMessage: string } }).data.errorMessage).toHaveLength(
      2000,
    );
  });

  it('upserts daily usage and increments the project tally in one transaction', async () => {
    const { db, calls } = fakeDb();
    const repo = createPrismaProviderJobRepository(db);
    await repo.recordUsage({
      organisationId: 'o',
      provider: 'runway',
      day: new Date('2026-09-27T15:00:00Z'),
      succeeded: true,
      costPence: 40,
      projectId: 'p',
    });
    expect(calls[0]).toEqual([
      'providerUsage.upsert',
      {
        where: {
          organisationId_provider_day: {
            organisationId: 'o',
            provider: 'runway',
            day: new Date('2026-09-27T00:00:00Z'),
          },
        },
        create: {
          organisationId: 'o',
          provider: 'runway',
          day: new Date('2026-09-27T00:00:00Z'),
          jobCount: 1,
          succeededCount: 1,
          failedCount: 0,
          costPence: 40,
        },
        update: {
          jobCount: { increment: 1 },
          succeededCount: { increment: 1 },
          failedCount: { increment: 0 },
          costPence: { increment: 40 },
        },
      },
    ]);
    expect(calls[1]).toEqual([
      'videoProject.update',
      { where: { id: 'p' }, data: { costActualPence: { increment: 40 } } },
    ]);
  });

  it('skips the project update for failures with no cost', async () => {
    const { db, calls } = fakeDb();
    await createPrismaProviderJobRepository(db).recordUsage({
      organisationId: 'o',
      provider: 'runway',
      day: new Date(),
      succeeded: false,
      costPence: 0,
      projectId: 'p',
    });
    expect(calls.map(([n]) => n)).toEqual(['providerUsage.upsert']);
  });
});

describe('budget checker', () => {
  function db(project: unknown, usage: unknown) {
    return {
      videoProject: { findUnique: vi.fn(async () => project) },
      providerUsage: { findUnique: vi.fn(async () => usage) },
    } as unknown as PrismaClient;
  }
  const ask = { organisationId: 'o', projectId: 'p', providerId: 'runway', estimatedCostPence: 50 };

  it('enforces the project hard cap (spec 12.5)', async () => {
    await expect(
      createPrismaBudgetChecker(db({ costBudgetPence: 100, costActualPence: 50 }, null)).hasBudget(
        ask,
      ),
    ).resolves.toBe(true);
    await expect(
      createPrismaBudgetChecker(db({ costBudgetPence: 100, costActualPence: 51 }, null)).hasBudget(
        ask,
      ),
    ).resolves.toBe(false);
    await expect(
      createPrismaBudgetChecker(
        db({ costBudgetPence: null, costActualPence: 999 }, null),
      ).hasBudget(ask),
    ).resolves.toBe(true);
  });

  it('enforces the org × provider daily cap when configured', async () => {
    const checker = (spent: number | null) =>
      createPrismaBudgetChecker(db(null, spent === null ? null : { costPence: spent }), {
        orgProviderDailyCapPence: 100,
      });
    await expect(checker(null).hasBudget(ask)).resolves.toBe(true);
    await expect(checker(50).hasBudget(ask)).resolves.toBe(true);
    await expect(checker(51).hasBudget(ask)).resolves.toBe(false);
  });

  it('parses the daily cap env var', () => {
    expect(orgProviderDailyCapFromEnv()).toBeUndefined();
    vi.stubEnv('STUDIO_ORG_PROVIDER_DAILY_CAP_PENCE', '5000');
    expect(orgProviderDailyCapFromEnv()).toBe(5000);
    vi.stubEnv('STUDIO_ORG_PROVIDER_DAILY_CAP_PENCE', '1.5');
    expect(() => orgProviderDailyCapFromEnv()).toThrow(ConfigurationError);
  });
});
