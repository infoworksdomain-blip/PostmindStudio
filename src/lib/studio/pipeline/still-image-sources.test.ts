import { describe, expect, it, vi } from 'vitest';

// 22 (production 2026-10-06): UGC B-roll asks the library for the business's own pictures only;
// a generic stock image imported into the library must not become the "product in use" shot.

vi.mock('../images/library', () => ({
  libraryDepsFrom: () => ({}),
  searchLibrary: async () => [{ id: 'img-1', similarity: 0.9 }],
  embedMissing: async () => undefined,
  stockLicenceNote: () => '',
}));

const { findLibraryStill } = await import('./still-image');

function depsWith(findMany: (args: unknown) => Promise<unknown[]>) {
  return {
    db: {
      imageLibraryItem: {
        findMany,
        update: async ({ where }: { where: { id: string } }) => ({ id: where.id }),
      },
    },
    logger: { warn: () => undefined },
    now: () => 0,
  } as never;
}

const scope = { organisationId: 'org-1', businessId: 'biz-1', planTier: 'STANDARD' as const };

describe('findLibraryStill sources', () => {
  it('filters to the requested sources', async () => {
    const calls: unknown[] = [];
    const deps = depsWith(async (args) => {
      calls.push(args);
      return [];
    });
    await expect(
      findLibraryStill(deps, scope, 'hands holding a phone', ['UPLOAD', 'SCRAPED']),
    ).resolves.toBeNull();
    expect(calls[0]).toMatchObject({ where: { source: { in: ['UPLOAD', 'SCRAPED'] } } });
  });

  it('keeps any source when none is asked for', async () => {
    const calls: Array<{ where: Record<string, unknown> }> = [];
    const deps = depsWith(async (args) => {
      calls.push(args as { where: Record<string, unknown> });
      return [{ id: 'img-1', s3Key: 'k', source: 'STOCK' }];
    });
    const hit = await findLibraryStill(deps, scope, 'hands holding a phone');
    expect(hit).toMatchObject({ id: 'img-1' });
    expect(calls[0]?.where).not.toHaveProperty('source');
  });
});
