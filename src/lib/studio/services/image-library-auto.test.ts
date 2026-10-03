import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ConfigurationError } from '../../errors';
import type { TenantContext } from '../../tenant';
import type { JobQueue } from '../queue/enqueue';
import {
  AUTO_STOCK_INTERVAL_MS,
  AUTO_STOCK_LIBRARY_TARGET,
  AUTO_STOCK_PER_QUERY,
  autoRefreshStock,
} from './image-library';

// BACKLOG 20.26 — automatic stock refresh on profile save (cheap, rate-limited, cached).

const NOW = Date.parse('2026-10-03T10:00:00Z');
const tenant = {
  organisationId: 'org-1',
  organisation: { id: 'org-1', planTier: 'STANDARD' },
} as unknown as TenantContext;

function setup(
  options: {
    queries?: string[];
    libraryCount?: number;
    businessRecent?: number;
    orgRecent?: number;
    stockConfigured?: boolean;
  } = {},
) {
  const imageLibraryQuery = {
    count: vi.fn(async (args: { where: { businessId: unknown } }) =>
      typeof args.where.businessId === 'string'
        ? (options.businessRecent ?? 0)
        : (options.orgRecent ?? 0),
    ),
  };
  const db = {
    businessProfile: {
      findFirst: vi.fn(async () => ({
        imageSearchQueries: options.queries ?? ['team meeting', 'office desk', 'notebook', 'x'],
      })),
      findMany: vi.fn(async () => [{ businessId: 'biz-1' }]),
    },
    imageLibraryItem: { count: vi.fn(async () => options.libraryCount ?? 1) },
    imageLibraryQuery,
  };
  const queue = { add: vi.fn(async () => undefined) };
  const logger = { warn: vi.fn() };
  const deps = {
    db: db as unknown as PrismaClient,
    queue: queue as unknown as JobQueue,
    now: () => NOW,
    library: {
      stock: () => {
        if (options.stockConfigured === false)
          throw new ConfigurationError('No stock image provider configured');
        return { primary: [], fallback: [] };
      },
      logger: logger as never,
    },
  };
  return { deps, db, queue, logger, imageLibraryQuery };
}

const save = (changedFields: string[] = ['imageSearchQueries']) => ({
  businessId: 'biz-1',
  changedFields,
});

describe('autoRefreshStock (20.26)', () => {
  it('queues a small refresh (3 queries × 6 images) for a thin library', async () => {
    const { deps, queue } = setup();
    expect(await autoRefreshStock(deps, tenant, save())).toBe('queued');
    expect(queue.add).toHaveBeenCalledWith(
      'refresh-image-library',
      {
        organisationId: 'org-1',
        businessId: 'biz-1',
        runId: 'auto-2026-10-03',
        planTier: 'STANDARD',
        queries: ['team meeting', 'office desk', 'notebook'],
        perQuery: AUTO_STOCK_PER_QUERY,
      },
      { jobId: 'refresh-image-library__biz-1__auto-2026-10-03' },
    );
  });

  it('looks back one day for any stock search of the business', async () => {
    const { deps, imageLibraryQuery, queue } = setup({ businessRecent: 1 });
    expect(await autoRefreshStock(deps, tenant, save())).toBe('recent');
    expect(imageLibraryQuery.count).toHaveBeenCalledWith({
      where: {
        businessId: 'biz-1',
        lastRunAt: { gte: new Date(NOW - AUTO_STOCK_INTERVAL_MS) },
      },
    });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('skips a library that already has enough images', async () => {
    const { deps, queue } = setup({ libraryCount: AUTO_STOCK_LIBRARY_TARGET });
    expect(await autoRefreshStock(deps, tenant, save())).toBe('library_full');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('stays inside the organisation hourly refresh cap', async () => {
    const { deps, queue } = setup({ orgRecent: 100 });
    expect(await autoRefreshStock(deps, tenant, save())).toBe('rate_limited');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does nothing for edits that cannot change the photos, or a bare confirmation', async () => {
    const { deps, db } = setup();
    expect(await autoRefreshStock(deps, tenant, save(['toneIndicators']))).toBe('not_relevant');
    expect(await autoRefreshStock(deps, tenant, save(['confirmed']))).toBe('not_relevant');
    expect(db.businessProfile.findFirst).not.toHaveBeenCalled();
  });

  it('does nothing without a stock source or without profile queries', async () => {
    expect(await autoRefreshStock(setup({ stockConfigured: false }).deps, tenant, save())).toBe(
      'not_configured',
    );
    expect(await autoRefreshStock(setup({ queries: [] }).deps, tenant, save())).toBe('no_queries');
  });

  it('never fails the profile save: a queue outage is logged and reported', async () => {
    const { deps, queue, logger } = setup();
    queue.add.mockRejectedValue(new Error('redis down'));
    expect(await autoRefreshStock(deps, tenant, save())).toBe('failed');
    expect(logger.warn).toHaveBeenCalled();
  });
});
