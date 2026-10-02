import type { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRunDeps } from '../pipeline/provider-run';
import { createLibraryCache, type LibraryCacheClient } from './cache';

// BACKLOG 20.15 — the query-embedding cache: a repeated search makes no paid provider call.

const provider = vi.hoisted(() => ({ runProvider: vi.fn() }));
vi.mock('../pipeline/provider-run', () => provider);
vi.mock('../vector-sql', async () => {
  const actual = await vi.importActual<typeof import('../vector-sql')>('../vector-sql');
  return { ...actual, vectorSql: async () => actual.vectorSqlFor('studio') };
});

const { QUERY_EMBEDDING_MODEL, searchLibrary } = await import('./search');

const silent = pino({ level: 'silent' });
const vector = Array.from({ length: 1536 }, (_, i) => (i % 7) / 8);
const scope = { organisationId: 'org', planTier: 'STANDARD' as const };
const input = { q: 'sourdough bread', limit: 2 };

function memoryClient(): LibraryCacheClient {
  const store = new Map<string, string>();
  return {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value);
      return 'OK';
    },
    incr: async () => 1,
  };
}

const embeddingRun = (providerId: string) => ({
  decision: { providerId },
  output: { metadata: { embeddings: [vector] } },
});

let db: PrismaClient;
beforeEach(() => {
  provider.runProvider.mockReset();
  db = {
    $queryRaw: vi.fn(async () => [{ id: 'a', distance: 0.1, boost: 0 }]),
  } as unknown as PrismaClient;
});

describe('searchLibrary query embedding cache', () => {
  it('embeds a query once; the repeat (any spacing or case) makes no provider call', async () => {
    provider.runProvider.mockResolvedValue(embeddingRun('openai'));
    const cache = createLibraryCache({
      client: memoryClient(),
      logger: silent,
      counter: { inc: vi.fn() },
    });
    const deps = { db, providers: {} as ProviderRunDeps, cache };

    const first = await searchLibrary(deps, scope, input);
    const second = await searchLibrary(deps, scope, { ...input, q: '  Sourdough  BREAD' });

    expect(provider.runProvider).toHaveBeenCalledTimes(1);
    expect(second.hits).toEqual(first.hits);
    expect(first.hits[0]).toMatchObject({ id: 'a', similarity: 0.9 });
    expect(QUERY_EMBEDDING_MODEL).toBe('openai:text-embedding-3-large:1536');
  });

  it("does not cache another provider's vectors", async () => {
    provider.runProvider.mockResolvedValue(embeddingRun('some-other-provider'));
    const cache = createLibraryCache({
      client: memoryClient(),
      logger: silent,
      counter: { inc: vi.fn() },
    });
    const deps = { db, providers: {} as ProviderRunDeps, cache };
    await searchLibrary(deps, scope, input);
    await searchLibrary(deps, scope, input);
    expect(provider.runProvider).toHaveBeenCalledTimes(2);
  });

  it('without a cache every search pays for an embedding (pre-20.15 behaviour)', async () => {
    provider.runProvider.mockResolvedValue(embeddingRun('openai'));
    const deps = { db, providers: {} as ProviderRunDeps };
    await searchLibrary(deps, scope, input);
    await searchLibrary(deps, scope, input);
    expect(provider.runProvider).toHaveBeenCalledTimes(2);
  });
});
